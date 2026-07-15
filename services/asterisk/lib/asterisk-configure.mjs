import { stderr as errout } from "node:process";

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { shellQuote } from "../../step-ca/lib/step-ca-render.mjs";
import { renderAllConfigFiles, buildEnsureIncludesScript } from "./asterisk-render.mjs";
import { installAsteriskViaExec, resolvePveSshForHost } from "./asterisk-install.mjs";

export { createConfigureExec };

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").resolveAsteriskDeployments>[number]} deployment
 * @param {string} proxmoxRoot
 * @param {string} [ipFallback]
 */
export function resolveConfigureExec(deployment, proxmoxRoot, ipFallback) {
  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const via = typeof configure.via === "string" ? configure.via.trim() : "ssh";
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};

  if (deployment.mode === "proxmox-lxc" || via === "pct") {
    const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
    if (!hostId) throw new Error(`${deployment.systemId}: proxmox.host_id required`);
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error(`${deployment.systemId}: proxmox.lxc.vmid required`);
    }
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    return createConfigureExec("pct", {
      user: pveSsh.user,
      host: pveSsh.host,
      vmid,
      pveHost: pveSsh.host,
    });
  }

  const ssh = isObject(configure.ssh) ? configure.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  let host = typeof ssh.host === "string" ? ssh.host.trim() : "";
  if (!host && ipFallback) host = ipFallback.split("/")[0];
  if (!host) {
    const q = isObject(px.qemu) ? px.qemu : {};
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    if (ip) host = ip.split("/")[0];
  }
  if (!host) throw new Error(`${deployment.systemId}: configure.ssh.host required`);
  return createConfigureExec("ssh", { user, host });
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 */
function runChecked(exec, cmd) {
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} remotePath
 * @param {string} content
 */
function uploadFile(exec, remotePath, content) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`);
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {Record<string, unknown>} opts.asterisk
 * @param {{ username: string; password: string; endpointPasswords?: Record<string, string> }} opts.secrets
 * @param {boolean} [opts.skipInstall]
 * @param {boolean} [opts.skipPackageUpgrade]
 * @param {boolean} [opts.restartService]
 */
export async function configureAsteriskServer(opts) {
  const {
    exec,
    asterisk,
    secrets,
    skipInstall = false,
    skipPackageUpgrade = true,
    restartService = true,
  } = opts;

  errout.write(`[hdc] asterisk configure: ${exec.label} …\n`);

  if (!skipInstall) {
    const install = await installAsteriskViaExec(exec, { skipUpgrade: !skipPackageUpgrade });
    if (!install.ok) {
      return install;
    }
  } else {
    runChecked(exec, buildEnsureIncludesScript());
  }

  const endpointPasswords = secrets.endpointPasswords ?? {};
  const files = renderAllConfigFiles(asterisk, {
    username: secrets.username,
    password: secrets.password,
    endpointPasswords,
  });

  for (const [relPath, content] of Object.entries(files)) {
    const remotePath = `/etc/asterisk/${relPath}`;
    const dir = remotePath.replace(/\/[^/]+$/, "");
    runChecked(exec, `mkdir -p ${shellQuote(dir)}`);
    uploadFile(exec, remotePath, content);
    errout.write(`[hdc] asterisk configure: wrote ${relPath}\n`);
  }

  runChecked(exec, "asterisk -rx 'module reload res_pjsip.so' 2>/dev/null || true");
  runChecked(exec, "asterisk -rx 'dialplan reload' 2>/dev/null || true");

  if (restartService) {
    runChecked(exec, "systemctl restart asterisk");
    runChecked(exec, "systemctl is-active --quiet asterisk");
  }

  errout.write(`[hdc] asterisk configure: completed on ${exec.label}.\n`);
  return { ok: true, message: "asterisk configured", files: Object.keys(files) };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} asterisk
 * @param {{ username: string; password: string; endpointPasswords?: Record<string, string> }} secrets
 * @param {{ skipInstall?: boolean; skipPackageUpgrade?: boolean }} [opts]
 */
export async function configureAsteriskInCt(user, pveHost, vmid, asterisk, secrets, opts = {}) {
  const exec = createConfigureExec("pct", {
    user,
    host: pveHost,
    vmid,
    pveHost,
  });
  return configureAsteriskServer({
    exec,
    asterisk,
    secrets,
    skipInstall: opts.skipInstall,
    skipPackageUpgrade: opts.skipPackageUpgrade !== false,
    restartService: true,
  });
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {{ skipPackageUpgrade?: boolean }} [opts]
 */
export async function maintainAsteriskInCt(user, pveHost, vmid, asterisk, secrets, opts = {}) {
  if (opts.skipPackageUpgrade === false) {
    errout.write(`[hdc] asterisk maintain: upgrading packages on CT ${vmid} …\n`);
    const inner = [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -qq",
      "apt-get upgrade -y -qq asterisk 2>/dev/null || true",
    ].join("\n");
    pctExec(user, pveHost, vmid, inner);
  }
  return configureAsteriskInCt(user, pveHost, vmid, asterisk, secrets, {
    skipInstall: true,
    skipPackageUpgrade: opts.skipPackageUpgrade !== false,
  });
}
