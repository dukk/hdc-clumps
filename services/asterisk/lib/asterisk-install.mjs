import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolvePveSshForHost, waitForCt } from "../../pi-hole/lib/pi-hole-install.mjs";
import { buildEnsureIncludesScript } from "./asterisk-render.mjs";

export { resolvePveSshForHost, waitForCt };

/**
 * @param {{ upgrade?: boolean }} [opts]
 */
export function buildAsteriskInstallScript(opts = {}) {
  const upgrade = opts.upgrade === true;
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
  ];
  if (upgrade) {
    lines.push("apt-get upgrade -y -qq asterisk asterisk-core-sounds-en 2>/dev/null || true");
  } else {
    lines.push("apt-get install -y -qq asterisk asterisk-core-sounds-en");
  }
  lines.push(
    buildEnsureIncludesScript(),
    "systemctl enable asterisk",
    "systemctl restart asterisk",
    "sleep 2",
    "systemctl is-active --quiet asterisk",
    'test -x /usr/sbin/asterisk',
  );
  return lines.join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function installAsteriskInCt(user, pveHost, vmid, opts = {}) {
  errout.write(`[hdc] asterisk install: CT ${vmid} on ${pveHost} …\n`);

  const ready = await waitForCt(user, pveHost, vmid, 2000, "asterisk install");
  if (!ready) {
    return { ok: false, message: `CT ${vmid} not reachable via pct exec` };
  }

  const inner = buildAsteriskInstallScript({ upgrade: opts.skipUpgrade === false });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `asterisk install failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 500),
    };
  }
  errout.write(`[hdc] asterisk install: completed on CT ${vmid}.\n`);
  return { ok: true, message: "asterisk installed", method: "apt" };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {{ skipUpgrade?: boolean }} [opts]
 */
export async function installAsteriskViaExec(exec, opts = {}) {
  errout.write(`[hdc] asterisk install: ${exec.label} …\n`);
  const inner = buildAsteriskInstallScript({ upgrade: opts.skipUpgrade === false });
  const r = exec.run(inner, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `asterisk install failed (exit ${r.status})`,
      stderr: `${r.stderr}${r.stdout}`.slice(0, 500),
    };
  }
  errout.write(`[hdc] asterisk install: completed on ${exec.label}.\n`);
  return { ok: true, message: "asterisk installed", method: "apt" };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readCtPrimaryIp(user, pveHost, vmid) {
  const script = [
    "ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | head -1 | cut -d/ -f1",
  ].join("\n");
  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) return null;
  const ip = r.stdout.trim().split("\n")[0]?.trim();
  return ip || null;
}
