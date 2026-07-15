import { shellSingleQuote, sshBashLc } from "hdc/cli/lib/ssh-host-access.mjs";
import { parseIsoVolid } from "./deployments.mjs";

/**
 * @param {string} systemId
 * @returns {string}
 */
export function autounattendIsoBasename(systemId) {
  const safe = systemId.replace(/[^a-zA-Z0-9.-]+/g, "-").slice(0, 40);
  return `hdc-${safe}-autounattend.iso`;
}

/**
 * @param {string} isoStorage
 * @param {string} basename
 */
export function autounattendVolid(isoStorage, basename) {
  return `${isoStorage}:iso/${basename}`;
}

/**
 * @param {object} opts
 * @param {import("hdc/cli/lib/ssh-host-access.mjs").SshTarget} opts.sshTarget
 * @param {string} opts.xml
 * @param {string} opts.isoStorage
 * @param {string} opts.basename
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<string>} volid
 */
export async function buildAndUploadAutounattendIso(opts) {
  const { sshTarget, xml, isoStorage, basename, spawnSync, env, identities, log = () => {} } = opts;
  const volid = autounattendVolid(isoStorage, basename);
  const { storage, filename } = parseIsoVolid(volid);
  const remoteDir = `/var/lib/vz/template/iso`;
  const remoteIso = `${remoteDir}/${basename}`;
  const remoteXml = `/tmp/${basename}.xml`;
  const remoteDirQ = shellSingleQuote(remoteDir);
  const remoteIsoQ = shellSingleQuote(remoteIso);
  const remoteXmlQ = shellSingleQuote(remoteXml);

  const writeScript = `
set -e
mkdir -p ${remoteDirQ}
cat > ${remoteXmlQ} <<'HDC_UNATTEND_EOF'
${xml.replace(/\\/g, "\\\\").replace(/\$/g, "\\$")}
HDC_UNATTEND_EOF
if command -v genisoimage >/dev/null 2>&1; then
  genisoimage -quiet -o ${remoteIsoQ} -J -r ${remoteXmlQ}
elif command -v mkisofs >/dev/null 2>&1; then
  mkisofs -quiet -o ${remoteIsoQ} -J -r ${remoteXmlQ}
else
  echo "HDC_ERROR=no_iso_tool" >&2
  exit 1
fi
rm -f ${remoteXmlQ}
echo HDC_ISO_VOLID=${storage}:iso/${filename}
`.trim();

  log(`Building autounattend ISO on ${sshTarget.id ?? "host"} → ${volid} …`);
  const r = sshBashLc(sshTarget, writeScript, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 120_000,
  });
  if (r.status !== 0) {
    const err = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() || `ssh exit ${r.status ?? "?"}`;
    if (err.includes("no_iso_tool")) {
      throw new Error(
        "hypervisor missing genisoimage/mkisofs — install genisoimage on the Proxmox node",
      );
    }
    throw new Error(`autounattend ISO build failed: ${err.slice(0, 800)}`);
  }
  return volid;
}
