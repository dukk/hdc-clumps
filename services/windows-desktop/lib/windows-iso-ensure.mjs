import { shellSingleQuote, sshBashLc } from "hdc/cli/lib/ssh-host-access.mjs";
import { parseIsoVolid } from "./deployments.mjs";

/**
 * @param {string} sha256
 */
export function normalizeSha256(sha256) {
  const hex = String(sha256 ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error("iso.sha256 must be a 64-character hex SHA256 digest");
  }
  return hex;
}

/**
 * @param {string} remotePath
 * @param {string} sha256Hex
 */
export function buildSha256VerifyScript(remotePath, sha256Hex) {
  const pathQ = shellSingleQuote(remotePath);
  const hashQ = shellSingleQuote(sha256Hex);
  return `
set -e
if [ ! -f ${pathQ} ]; then
  echo HDC_ERROR=missing_file
  exit 1
fi
echo "${sha256Hex}  ${remotePath.replace(/"/g, '\\"')}" | sha256sum -c -
`.trim();
}

/**
 * @param {object} isoBlock
 * @param {boolean} refresh
 */
export function windowsIsoRemotePath(isoBlock, isoStorage) {
  const volid = String(isoBlock.windows_volid ?? "").trim();
  const { filename } = parseIsoVolid(volid);
  const storage =
    (typeof isoStorage === "string" && isoStorage.trim()) ||
    parseIsoVolid(volid).storage;
  const basename = filename.replace(/^iso\//, "");
  return {
    storage,
    basename,
    remotePath: `/var/lib/vz/template/iso/${basename}`,
    volid: `${storage}:iso/${basename}`,
  };
}

/**
 * Ensure Windows install ISO exists on the hypervisor and matches sha256 when configured.
 * @param {object} opts
 * @param {import("hdc/cli/lib/ssh-host-access.mjs").SshTarget} opts.sshTarget
 * @param {Record<string, unknown>} opts.iso
 * @param {string} opts.isoStorage
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {boolean} [opts.refresh]
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureWindowsIsoOnNode(opts) {
  const { sshTarget, iso, isoStorage, spawnSync, env, identities, refresh = false, log = () => {} } =
    opts;
  const downloadUrl =
    typeof iso.download_url === "string" && iso.download_url.trim()
      ? iso.download_url.trim()
      : "";
  const sha256Raw = typeof iso.sha256 === "string" ? iso.sha256.trim() : "";
  if (downloadUrl && !sha256Raw) {
    throw new Error("iso.sha256 is required when iso.download_url is set");
  }
  const sha256Hex = sha256Raw ? normalizeSha256(sha256Raw) : "";

  const { remotePath, volid, basename } = windowsIsoRemotePath(iso, isoStorage);

  const existsScript = `test -f ${shellSingleQuote(remotePath)} && echo yes || echo no`;
  const existsR = sshBashLc(sshTarget, existsScript, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 30_000,
  });
  const exists = String(existsR.stdout ?? "").trim() === "yes";

  if (refresh && exists) {
    log(`Removing existing Windows ISO at ${remotePath} (--refresh-iso).`);
    sshBashLc(sshTarget, `rm -f ${shellSingleQuote(remotePath)}`, {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 30_000,
    });
  }

  const existsAfterRefresh = refresh
    ? false
    : exists;

  if (!existsAfterRefresh) {
    if (downloadUrl) {
      log(`Downloading Windows ISO to ${remotePath} …`);
      const dlScript = `
set -e
mkdir -p /var/lib/vz/template/iso
wget -q -O ${shellSingleQuote(remotePath)} ${shellSingleQuote(downloadUrl)}
echo HDC_DOWNLOAD_OK=1
`.trim();
      const dlR = sshBashLc(sshTarget, dlScript, {
        spawnSync,
        env,
        mode: "pubkey",
        identities,
        timeoutMs: 3_600_000,
      });
      if (dlR.status !== 0) {
        const err = `${dlR.stderr ?? ""}${dlR.stdout ?? ""}`.trim();
        throw new Error(`Windows ISO download failed: ${err.slice(0, 800)}`);
      }
    } else if (!exists) {
      throw new Error(
        `Windows ISO not found at ${remotePath} — upload to the node or set iso.download_url + iso.sha256`,
      );
    }
  } else {
    log(`Windows ISO already present at ${remotePath}.`);
  }

  if (sha256Hex) {
    log(`Verifying SHA256 for ${basename} …`);
    const verifyR = sshBashLc(
      sshTarget,
      buildSha256VerifyScript(remotePath, sha256Hex),
      {
        spawnSync,
        env,
        mode: "pubkey",
        identities,
        timeoutMs: 600_000,
      },
    );
    if (verifyR.status !== 0) {
      const err = `${verifyR.stderr ?? ""}${verifyR.stdout ?? ""}`.trim();
      throw new Error(`Windows ISO SHA256 mismatch for ${basename}: ${err.slice(0, 400)}`);
    }
    log(`SHA256 verified for ${basename}.`);
  }

  return { volid, remotePath, verified: Boolean(sha256Hex) };
}

/**
 * Download virtio-win.iso when missing (stable Fedora path).
 * @param {object} opts
 * @param {import("hdc/cli/lib/ssh-host-access.mjs").SshTarget} opts.sshTarget
 * @param {string} opts.virtioVolid
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureVirtioIsoOnNode(opts) {
  const { sshTarget, virtioVolid, spawnSync, env, identities, log = () => {} } = opts;
  const { filename } = parseIsoVolid(virtioVolid);
  const basename = filename.replace(/^iso\//, "");
  const remotePath = `/var/lib/vz/template/iso/${basename}`;
  const existsScript = `test -s ${shellSingleQuote(remotePath)} && echo yes || echo no`;
  const existsR = sshBashLc(sshTarget, existsScript, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 30_000,
  });
  if (String(existsR.stdout ?? "").trim() === "yes") {
    log(`VirtIO ISO already present at ${remotePath}.`);
    return { volid: virtioVolid };
  }
  const url =
    "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso";
  log(`Downloading VirtIO ISO to ${remotePath} …`);
  const dlScript = `
set -e
mkdir -p /var/lib/vz/template/iso
wget -q -O ${shellSingleQuote(remotePath)} ${shellSingleQuote(url)}
test -s ${shellSingleQuote(remotePath)}
`.trim();
  const dlR = sshBashLc(sshTarget, dlScript, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 900_000,
  });
  if (dlR.status !== 0) {
    const err = `${dlR.stderr ?? ""}${dlR.stdout ?? ""}`.trim();
    throw new Error(`VirtIO ISO download failed: ${err.slice(0, 800)}`);
  }
  return { volid: virtioVolid };
}
