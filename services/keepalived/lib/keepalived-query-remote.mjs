import { KEEPALIVED_CONF_PATH } from "./keepalived-install.mjs";
import { shellQuote } from "./keepalived-render.mjs";

/**
 * @param {ReturnType<typeof import("./keepalived-configure.mjs").createConfigureExec>} exec
 */
export function queryKeepalivedServiceActive(exec) {
  const r = exec.run("systemctl is-active keepalived", { capture: true });
  const active = r.stdout.trim() === "active";
  return { active, status: r.stdout.trim() || r.stderr.trim() };
}

/**
 * @param {ReturnType<typeof import("./keepalived-configure.mjs").createConfigureExec>} exec
 * @param {string[]} vipAddresses
 */
export function queryVipPresent(exec, vipAddresses) {
  const r = exec.run("ip -4 -o addr show", { capture: true });
  const text = `${r.stdout}${r.stderr}`;
  /** @type {Record<string, boolean>} */
  const present = {};
  for (const vip of vipAddresses) {
    const addr = vip.includes("/") ? vip.split("/")[0] : vip;
    present[addr] = text.includes(addr);
  }
  const anyPresent = Object.values(present).some(Boolean);
  return { any_present: anyPresent, addresses: present };
}

/**
 * @param {ReturnType<typeof import("./keepalived-configure.mjs").createConfigureExec>} exec
 */
export function queryIpvsRules(exec) {
  const r = exec.run("ipvsadm -Ln 2>/dev/null || true", { capture: true });
  const text = r.stdout.trim();
  const lines = text ? text.split("\n").length : 0;
  return { ok: r.status === 0 || text.length > 0, line_count: lines, preview: text.slice(0, 2000) };
}

/**
 * @param {ReturnType<typeof import("./keepalived-configure.mjs").createConfigureExec>} exec
 */
export function queryKeepalivedConfigPresent(exec) {
  const r = exec.run(`test -s ${shellQuote(KEEPALIVED_CONF_PATH)}`, { capture: true });
  return { present: r.status === 0, path: KEEPALIVED_CONF_PATH };
}

/**
 * @param {ReturnType<typeof import("./keepalived-configure.mjs").createConfigureExec>} exec
 * @param {string} vip
 */
export function queryDrLoVip(exec, vip) {
  const addr = vip.includes("/") ? vip.split("/")[0] : vip;
  const r = exec.run(`ip -4 -o addr show dev lo | grep -F ${shellQuote(addr)} || true`, {
    capture: true,
  });
  return { present: r.stdout.trim().length > 0, address: addr };
}
