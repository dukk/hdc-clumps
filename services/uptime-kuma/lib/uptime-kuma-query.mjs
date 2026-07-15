import { pctExec } from "hdc/package/pve-pct-remote.mjs";

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {number} port
 */
export function queryUptimeKumaInCt(user, pveHost, vmid, port) {
  const p = Number.isFinite(port) && port > 0 ? Math.trunc(port) : 3001;
  const script = [
    "set -euo pipefail",
    "ACTIVE=unknown",
    "if systemctl is-active --quiet uptime-kuma; then ACTIVE=active; else ACTIVE=inactive; fi",
    "VERSION=",
    "if [ -f /opt/uptime-kuma/package.json ]; then",
    "  VERSION=$(node -e \"const p=require('/opt/uptime-kuma/package.json'); process.stdout.write(String(p.version||''))\" 2>/dev/null || true)",
    "fi",
    "TAG=$(cat /opt/uptime-kuma/.hdc-release-tag 2>/dev/null || true)",
    `HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 http://127.0.0.1:${p}/ 2>/dev/null || echo 000)`,
    "echo \"active=$ACTIVE\"",
    "echo \"version=$VERSION\"",
    "echo \"release_tag=$TAG\"",
    "echo \"http_code=$HTTP\"",
  ].join("\n");

  const r = pctExec(user, pveHost, vmid, script, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `query failed (exit ${r.status})`,
      systemd: null,
      version: null,
      release_tag: null,
      http_code: null,
    };
  }

  /** @type {Record<string, string>} */
  const kv = {};
  for (const line of r.stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    kv[line.slice(0, idx)] = line.slice(idx + 1);
  }

  const active = kv.active === "active";
  const httpCode = kv.http_code ?? "";
  const httpOk = httpCode.length === 3 && !httpCode.startsWith("5") && httpCode !== "000";

  return {
    ok: active && httpOk,
    message: active ? (httpOk ? "running" : `http ${httpCode}`) : "service inactive",
    systemd: kv.active ?? "unknown",
    version: kv.version || null,
    release_tag: kv.release_tag || null,
    http_code: httpCode || null,
    port: p,
  };
}
