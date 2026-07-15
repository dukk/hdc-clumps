import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import {
  buildComposeDownScript,
  buildGenerateConfigEnv,
  buildInstallScript,
  buildMaintainScript,
  buildReverseProxyConfScript,
  buildTimezoneConfScript,
  installDir,
  normalizeTimezone,
  normalizeGitRef,
  resolveAdminUrl,
} from "./mailcow-render.mjs";
import {
  buildMailcowDataDiskMountScript,
  MAILCOW_DATA_MOUNT,
  MAILCOW_DOCKER_DATA_ROOT,
} from "./proxmox-data-disk.mjs";

export { resolvePveSshForHost };

/**
 * @param {(script: string) => { status: number }} runScript
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {string} label
 */
/**
 * @param {(script: string) => { status: number }} runScript
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {string} label
 * @param {{ restartCompose?: boolean }} [opts]
 */
function applyTimezoneConf(runScript, mailcow, install, label, opts = {}) {
  const dir = installDir(install);
  const tz = normalizeTimezone(mailcow);
  const restartCompose = opts.restartCompose !== false;

  errout.write(`[hdc] mailcow ${label}: applying timezone ${tz} …\n`);
  const tzScript = buildTimezoneConfScript(dir, mailcow);
  const tzResult = runScript(tzScript);
  if (tzResult.status !== 0) {
    return {
      ok: false,
      message: `timezone update failed (exit ${tzResult.status})`,
    };
  }

  if (!restartCompose) {
    return { ok: true, skipped: false, timezone: tz };
  }

  const escapedDir = dir.replace(/'/g, `'\\''`);
  const restart = runScript(`set -euo pipefail\ncd '${escapedDir}'\ndocker compose up -d`);
  if (restart.status !== 0) {
    return {
      ok: false,
      message: `timezone compose restart failed (exit ${restart.status})`,
    };
  }
  return { ok: true, skipped: false, timezone: tz };
}

function applyReverseProxyConf(runScript, mailcow, install, label) {
  const dir = installDir(install);
  const reverseProxy = buildReverseProxyConfScript(dir, mailcow);
  if (!reverseProxy) return { ok: true, skipped: true };

  errout.write(`[hdc] mailcow ${label}: applying reverse-proxy settings in mailcow.conf …\n`);
  const rpResult = runScript(reverseProxy);
  if (rpResult.status !== 0) {
    return {
      ok: false,
      message: `reverse-proxy mailcow.conf update failed (exit ${rpResult.status})`,
    };
  }

  const escapedDir = dir.replace(/'/g, `'\\''`);
  const restart = runScript(`set -euo pipefail\ncd '${escapedDir}'\ndocker compose up -d`);
  if (restart.status !== 0) {
    return {
      ok: false,
      message: `reverse-proxy compose restart failed (exit ${restart.status})`,
    };
  }
  return { ok: true, skipped: false };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readCtPrimaryIp(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  if (r.status !== 0) return null;
  const ip = r.stdout.trim().split(/\s+/)[0];
  return ip || null;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {{ dbpass: string; dbroot: string; redispass: string }} secrets
 * @param {number} [dataDiskGb]
 */
export async function installMailcowOnHost(exec, mailcow, install, secrets, dataDiskGb = 0) {
  errout.write(`[hdc] mailcow install: mailcow-dockerized via ${exec.label} …\n`);

  const dir = installDir(install);
  const gitRef = normalizeGitRef(mailcow);
  const genEnv = buildGenerateConfigEnv(mailcow, secrets);
  const useDataDisk = dataDiskGb > 0;
  const inner = buildInstallScript(dir, gitRef, genEnv, {
    dataDiskMountScript: useDataDisk ? buildMailcowDataDiskMountScript(MAILCOW_DATA_MOUNT) : undefined,
    dockerDataRoot: useDataDisk ? MAILCOW_DOCKER_DATA_ROOT : undefined,
  });

  const r = exec.run(inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "mailcow-dockerized",
      message: `install failed (exit ${r.status})`,
      detail: `${r.stderr}${r.stdout}`.trim() || null,
    };
  }

  const rp = applyReverseProxyConf((script) => exec.run(script), mailcow, install, "install");
  if (!rp.ok) {
    return {
      ok: false,
      method: "mailcow-dockerized",
      message: rp.message || "reverse-proxy apply failed",
    };
  }

  const tz = applyTimezoneConf((script) => exec.run(script), mailcow, install, "install");
  if (!tz.ok) {
    return {
      ok: false,
      method: "mailcow-dockerized",
      message: tz.message || "timezone apply failed",
    };
  }

  const ipOut = exec.run("hostname -I | awk '{print $1}'");
  const guestIp = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  errout.write(`[hdc] mailcow install: completed on ${guestIp ?? "guest"}.\n`);
  return {
    ok: true,
    method: "mailcow-dockerized",
    message: "installed",
    admin_url: resolveAdminUrl(mailcow),
    guest_ip: guestIp,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {{ dbpass: string; dbroot: string; redispass: string }} secrets
 */
export async function installMailcowInCt(user, pveHost, vmid, mailcow, install, secrets) {
  errout.write(`[hdc] mailcow install: mailcow-dockerized in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "mailcow install");
  if (!ready) {
    return { ok: false, method: "mailcow-dockerized", message: `CT ${vmid} not reachable via pct exec` };
  }

  const dir = installDir(install);
  const gitRef = normalizeGitRef(mailcow);
  const genEnv = buildGenerateConfigEnv(mailcow, secrets);
  const inner = buildInstallScript(dir, gitRef, genEnv);

  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: "mailcow-dockerized",
      message: `install failed (exit ${r.status})`,
    };
  }

  const rp = applyReverseProxyConf(
    (script) => pctExec(user, pveHost, vmid, script),
    mailcow,
    install,
    "install",
  );
  if (!rp.ok) {
    return {
      ok: false,
      method: "mailcow-dockerized",
      message: rp.message || "reverse-proxy apply failed",
    };
  }

  const tz = applyTimezoneConf(
    (script) => pctExec(user, pveHost, vmid, script),
    mailcow,
    install,
    "install",
  );
  if (!tz.ok) {
    return {
      ok: false,
      method: "mailcow-dockerized",
      message: tz.message || "timezone apply failed",
    };
  }

  const ip = readCtPrimaryIp(user, pveHost, vmid);
  errout.write(`[hdc] mailcow install: completed on CT ${vmid}.\n`);
  return {
    ok: true,
    method: "mailcow-dockerized",
    message: "installed",
    admin_url: resolveAdminUrl(mailcow),
    ct_ip: ip,
    guest_ip: ip,
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainMailcowStackOnHost(exec, mailcow, install, opts = {}) {
  errout.write(`[hdc] mailcow maintain: refreshing stack via ${exec.label} …\n`);

  const dir = installDir(install);
  const rp = applyReverseProxyConf((script) => exec.run(script), mailcow, install, "maintain");
  if (!rp.ok) {
    return { ok: false, message: rp.message || "reverse-proxy apply failed" };
  }
  const tz = applyTimezoneConf((script) => exec.run(script), mailcow, install, "maintain", {
    restartCompose: false,
  });
  if (!tz.ok) {
    return { ok: false, message: tz.message || "timezone apply failed" };
  }
  const inner = buildMaintainScript(dir, opts);
  const r = exec.run(inner);
  if (r.status !== 0) {
    return { ok: false, message: `stack maintain failed (exit ${r.status})` };
  }
  const ipOut = exec.run("hostname -I | awk '{print $1}'");
  const guestIp = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    admin_url: resolveAdminUrl(mailcow),
    guest_ip: guestIp,
    ct_ip: guestIp,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function maintainMailcowStackInCt(user, pveHost, vmid, mailcow, install, opts = {}) {
  errout.write(`[hdc] mailcow maintain: refreshing stack in CT ${vmid} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "mailcow maintain");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const dir = installDir(install);
  const rp = applyReverseProxyConf(
    (script) => pctExec(user, pveHost, vmid, script),
    mailcow,
    install,
    "maintain",
  );
  if (!rp.ok) {
    return { ok: false, message: rp.message || "reverse-proxy apply failed" };
  }
  const tz = applyTimezoneConf(
    (script) => pctExec(user, pveHost, vmid, script),
    mailcow,
    install,
    "maintain",
    { restartCompose: false },
  );
  if (!tz.ok) {
    return { ok: false, message: tz.message || "timezone apply failed" };
  }
  const inner = buildMaintainScript(dir, opts);
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return { ok: false, message: `stack maintain failed (exit ${r.status})` };
  }
  const ip = readCtPrimaryIp(user, pveHost, vmid);
  return {
    ok: true,
    message: opts.skipUpgrade ? "restarted" : "images refreshed",
    admin_url: resolveAdminUrl(mailcow),
    ct_ip: ip,
    guest_ip: ip,
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} install
 */
export function composeDownOnHost(exec, install) {
  const dir = installDir(install);
  const inner = buildComposeDownScript(dir);
  exec.run(inner);
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} install
 */
export function composeDownInCt(user, pveHost, vmid, install) {
  const dir = installDir(install);
  const inner = buildComposeDownScript(dir);
  pctExec(user, pveHost, vmid, inner);
}
