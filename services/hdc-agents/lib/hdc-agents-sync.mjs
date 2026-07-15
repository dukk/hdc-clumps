import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { hdcPrivateRoot } from "hdc/cli/lib/private-repo.mjs";

/**
 * Build rsync exclude args from patterns.
 *
 * @param {string[]} patterns
 */
export function rsyncExcludeArgs(patterns) {
  /** @type {string[]} */
  const args = [];
  for (const p of patterns) {
    args.push("--exclude", p);
  }
  return args;
}

/**
 * @param {typeof spawnSync} [spawnFn]
 */
function hasRsyncOnPath(spawnFn = spawnSync) {
  const checker = process.platform === "win32" ? "where" : "which";
  const r = spawnFn(checker, ["rsync"], { encoding: "utf8", shell: true });
  return r.status === 0;
}

/**
 * @param {object} opts
 * @param {string} opts.localRoot
 * @param {string} opts.pveUser
 * @param {string} opts.pveHost
 * @param {number} opts.vmid
 * @param {string} opts.remotePath
 * @param {string[]} opts.excludeFlags
 * @param {boolean} [opts.delete]
 * @param {typeof spawnSync} opts.spawnSyncFn
 */
function tarToPctGuestTwoStep(opts) {
  const spawnFn = opts.spawnSyncFn;
  const prepCmd = [
    "set -euo pipefail",
    opts.delete !== false
      ? `rm -rf '${opts.remotePath}'/* '${opts.remotePath}'/.[!.]* 2>/dev/null || true`
      : "true",
    `mkdir -p '${opts.remotePath}'`,
  ].join("; ");

  const prep = spawnFn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${opts.pveUser}@${opts.pveHost}`,
      `pct exec ${opts.vmid} -- bash -lc ${JSON.stringify(prepCmd)}`,
    ],
    { encoding: "utf8", shell: false },
  );
  if (prep.status !== 0) {
    return {
      ok: false,
      message: `pct prep failed: ${`${prep.stderr}${prep.stdout}`.trim()}`,
      stdout: prep.stdout ?? "",
      stderr: prep.stderr ?? "",
    };
  }

  const tarResult = spawnFn("tar", ["-cf", "-", ...opts.excludeFlags, "-C", opts.localRoot, "."], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 512,
    shell: false,
  });
  const tarStderr = Buffer.isBuffer(tarResult.stderr)
    ? tarResult.stderr.toString("utf8")
    : String(tarResult.stderr ?? "");
  if (tarResult.status !== 0) {
    const detail = `${tarStderr}`.trim();
    return {
      ok: false,
      message: detail || `tar pack failed exit ${tarResult.status}`,
      stdout: "",
      stderr: detail,
    };
  }

  const r = spawnFn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${opts.pveUser}@${opts.pveHost}`,
      `pct exec ${opts.vmid} -- tar -xf - -C ${opts.remotePath}`,
    ],
    {
      input: tarResult.stdout,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      shell: false,
    },
  );
  const ok = r.status === 0;
  return {
    ok,
    message: ok ? "pct tar ok" : `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * Stream a local directory into an LXC via Proxmox host `pct exec` + tar
 * (works before guest SSH / hdc user exists).
 *
 * @param {object} opts
 * @param {string} opts.localRoot
 * @param {string} opts.pveUser
 * @param {string} opts.pveHost
 * @param {number} opts.vmid
 * @param {string} opts.remotePath
 * @param {string[]} opts.exclude
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.delete]
 * @param {typeof spawnSync} [opts.spawnSyncFn]
 */
export function tarToPctGuest(opts) {
  const localRoot = opts.localRoot.replace(/\\/g, "/");
  if (!existsSync(localRoot)) {
    return { ok: false, message: `local path missing: ${localRoot}`, stdout: "", stderr: "" };
  }
  const remotePath = String(opts.remotePath ?? "").replace(/\/$/, "");
  if (!remotePath.startsWith("/")) {
    return {
      ok: false,
      message: `invalid remotePath ${JSON.stringify(opts.remotePath)}`,
      stdout: "",
      stderr: "",
    };
  }
  if (opts.dryRun) {
    return { ok: true, message: "pct tar dry-run ok", stdout: "", stderr: "" };
  }

  /** @type {string[]} */
  const excludeFlags = [];
  for (const p of opts.exclude ?? []) {
    excludeFlags.push("--exclude", p);
  }

  return tarToPctGuestTwoStep({
    localRoot,
    pveUser: opts.pveUser,
    pveHost: opts.pveHost,
    vmid: opts.vmid,
    remotePath,
    excludeFlags,
    delete: opts.delete,
    spawnSyncFn: opts.spawnSyncFn ?? spawnSync,
  });
}

/**
 * Sync via Proxmox pct (pre-SSH bootstrap path).
 *
 * @param {object} opts
 * @param {string} opts.publicRoot
 * @param {string} opts.pveUser
 * @param {string} opts.pveHost
 * @param {number} opts.vmid
 * @param {string} opts.installRoot
 * @param {string} opts.privateRoot
 * @param {string[]} opts.exclude
 * @param {boolean} [opts.dryRun]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{ info: (msg: string) => void; warn?: (msg: string) => void }} opts.log
 */
export function syncHdcTreesViaPct(opts) {
  const env = opts.env ?? process.env;
  const privateLocal = hdcPrivateRoot(opts.publicRoot, env);
  if (!privateLocal) {
    return {
      ok: false,
      message: "hdc-private not found (set HDC_PRIVATE_ROOT or clone ../hdc-private)",
      public: null,
      private: null,
    };
  }

  opts.log.info(`pct tar public hdc → CT ${opts.vmid}:${opts.installRoot}/`);
  const publicResult = tarToPctGuest({
    localRoot: opts.publicRoot,
    pveUser: opts.pveUser,
    pveHost: opts.pveHost,
    vmid: opts.vmid,
    remotePath: opts.installRoot,
    exclude: opts.exclude,
    dryRun: opts.dryRun,
    delete: true,
  });
  if (!publicResult.ok) {
    return { ok: false, message: publicResult.message, public: publicResult, private: null };
  }

  opts.log.info(`pct tar hdc-private → CT ${opts.vmid}:${opts.privateRoot}/`);
  const privateResult = tarToPctGuest({
    localRoot: privateLocal,
    pveUser: opts.pveUser,
    pveHost: opts.pveHost,
    vmid: opts.vmid,
    remotePath: opts.privateRoot,
    exclude: opts.exclude,
    dryRun: opts.dryRun,
    delete: true,
  });

  return {
    ok: privateResult.ok,
    message: privateResult.ok ? "pct sync complete" : privateResult.message,
    public: publicResult,
    private: privateResult,
    private_local: privateLocal,
  };
}

/**
 * tar stream over SSH when rsync is unavailable (common on Windows operators).
 *
 * @param {object} opts
 * @param {string} opts.localRoot
 * @param {string} opts.remoteDest user@host:path/
 * @param {string[]} opts.exclude
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.delete]
 * @param {number} [opts.port]
 * @param {typeof spawnSync} [opts.spawnSyncFn]
 */
export function tarToRemote(opts) {
  const localRoot = opts.localRoot.replace(/\\/g, "/");
  if (!existsSync(localRoot)) {
    return { ok: false, message: `local path missing: ${localRoot}`, stdout: "", stderr: "" };
  }

  const dest = String(opts.remoteDest ?? "").trim();
  const at = dest.indexOf("@");
  const colon = dest.indexOf(":", at + 1);
  if (at <= 0 || colon <= at) {
    return { ok: false, message: `invalid remoteDest ${JSON.stringify(dest)}`, stdout: "", stderr: "" };
  }
  const remoteUser = dest.slice(0, at);
  const remoteHost = dest.slice(at + 1, colon);
  const remotePath = dest.slice(colon + 1).replace(/\/$/, "");
  const port = opts.port ?? 22;
  const spawnFn = opts.spawnSyncFn ?? spawnSync;

  if (opts.dryRun) {
    return { ok: true, message: "tar dry-run ok", stdout: "", stderr: "" };
  }

  /** @type {string[]} */
  const sshBaseArgs = [
    "-p",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${remoteUser}@${remoteHost}`,
  ];

  if (opts.delete !== false) {
    const clean = spawnFn(
      "ssh",
      [...sshBaseArgs, `sudo rm -rf ${remotePath}/* ${remotePath}/.[!.]* 2>/dev/null || true`],
      { encoding: "utf8", shell: false },
    );
    if (clean.status !== 0) {
      return {
        ok: false,
        message: `remote clean failed: ${`${clean.stderr}${clean.stdout}`.trim()}`,
        stdout: clean.stdout ?? "",
        stderr: clean.stderr ?? "",
      };
    }
  }

  /** @type {string[]} */
  const excludeFlags = [];
  for (const p of opts.exclude ?? []) {
    excludeFlags.push("--exclude", p);
  }

  const remoteTar = `sudo mkdir -p ${remotePath} && sudo chown -R hdc:hdc ${remotePath} && tar -xf - -C ${remotePath}`;
  const tarResult = spawnFn("tar", ["-cf", "-", ...excludeFlags, "-C", localRoot, "."], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 512,
    shell: false,
  });
  const tarStderr = Buffer.isBuffer(tarResult.stderr)
    ? tarResult.stderr.toString("utf8")
    : String(tarResult.stderr ?? "");
  if (tarResult.status !== 0) {
    const detail = `${tarStderr}${tarResult.stdout ?? ""}`.trim();
    return {
      ok: false,
      message: detail || `tar pack failed exit ${tarResult.status}`,
      stdout: "",
      stderr: detail,
    };
  }

  const r = spawnFn("ssh", [...sshBaseArgs, remoteTar], {
    input: tarResult.stdout,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    shell: false,
  });
  const ok = r.status === 0;
  return {
    ok,
    message: ok ? "tar+ssh ok" : `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * @param {object} opts
 * @param {string} opts.localRoot
 * @param {string} opts.remoteDest user@host:path/
 * @param {string[]} opts.exclude
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.delete]
 * @param {number} [opts.port]
 * @param {typeof spawnSync} [opts.spawnSyncFn]
 */
export function rsyncToRemote(opts) {
  const localRoot = opts.localRoot.replace(/\\/g, "/");
  if (!existsSync(localRoot)) {
    return { ok: false, message: `local path missing: ${localRoot}`, stdout: "", stderr: "" };
  }

  const src = localRoot.endsWith("/") ? localRoot : `${localRoot}/`;
  /** @type {string[]} */
  const args = ["-avz", ...rsyncExcludeArgs(opts.exclude ?? [])];
  if (opts.dryRun) args.push("-n");
  if (opts.delete !== false) args.push("--delete");
  if (opts.port && opts.port !== 22) {
    args.push(
      "-e",
      `ssh -p ${opts.port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
    );
  } else {
    args.push("-e", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
  }
  args.push(src, opts.remoteDest);

  const spawnFn = opts.spawnSyncFn ?? spawnSync;
  if (!hasRsyncOnPath(spawnFn)) {
    return tarToRemote(opts);
  }
  const r = spawnFn("rsync", args, { encoding: "utf8" });
  const ok = r.status === 0;
  return {
    ok,
    message: ok ? "rsync ok" : `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * Sync hdc public + private trees from operator workstation to agents guest.
 *
 * Guest-authoritative paths under private must be excluded by the caller
 * (operations/tasks/**, operations/task-report.md).
 *
 * @param {object} opts
 * @param {string} opts.publicRoot
 * @param {string} opts.remoteUser
 * @param {string} opts.remoteHost
 * @param {number} [opts.remotePort]
 * @param {string} opts.installRoot — typically /opt/hdc-src on guest
 * @param {string} opts.privateRoot — typically /opt/hdc-private
 * @param {string[]} opts.exclude
 * @param {boolean} [opts.dryRun]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{ info: (msg: string) => void; warn?: (msg: string) => void }} opts.log
 */
export function syncHdcTreesToGuest(opts) {
  const env = opts.env ?? process.env;
  const privateLocal = hdcPrivateRoot(opts.publicRoot, env);
  if (!privateLocal) {
    return {
      ok: false,
      message: "hdc-private not found (set HDC_PRIVATE_ROOT or clone ../hdc-private)",
      public: null,
      private: null,
    };
  }

  const remoteBase = `${opts.remoteUser}@${opts.remoteHost}`;
  const port = opts.remotePort ?? 22;

  const syncVia = hasRsyncOnPath() ? "rsync" : "tar+ssh";
  opts.log.info(`${syncVia} public hdc → ${remoteBase}:${opts.installRoot}/`);
  const publicResult = rsyncToRemote({
    localRoot: opts.publicRoot,
    remoteDest: `${remoteBase}:${opts.installRoot}/`,
    exclude: opts.exclude,
    dryRun: opts.dryRun,
    delete: true,
    port,
  });
  if (!publicResult.ok) {
    return { ok: false, message: publicResult.message, public: publicResult, private: null };
  }

  opts.log.info(`${syncVia} hdc-private → ${remoteBase}:${opts.privateRoot}/`);
  const privateResult = rsyncToRemote({
    localRoot: privateLocal,
    remoteDest: `${remoteBase}:${opts.privateRoot}/`,
    exclude: opts.exclude,
    dryRun: opts.dryRun,
    delete: true,
    port,
  });

  return {
    ok: privateResult.ok,
    message: privateResult.ok ? "sync complete" : privateResult.message,
    public: publicResult,
    private: privateResult,
    private_local: privateLocal,
  };
}

/**
 * Ensure remote directories exist before rsync.
 *
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {{ install_root: string, private_root: string, meta_root: string }} paths
 */
export function ensureAgentsDirectories(exec, paths) {
  const script = [
    "set -e",
    `mkdir -p '${paths.install_root}' '${paths.private_root}' '${paths.meta_root}/bin' '${paths.meta_root}/logs' /opt/hdc-src`,
    `chown -R hdc:hdc '${paths.install_root}' '${paths.private_root}' '${paths.meta_root}' /opt/hdc-src 2>/dev/null || true`,
  ].join("\n");
  const r = exec.run(script, { capture: true });
  if (r.status !== 0) {
    return { ok: false, message: `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}` };
  }
  return { ok: true, message: "directories ready" };
}
