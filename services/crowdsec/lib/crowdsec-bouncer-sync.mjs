import { loadManualSystemSidecar, primaryIpFromSystem } from "hdc/package/inventory-sidecar.mjs";
import { createGuestSshExec } from "hdc/package/guest-ssh-exec.mjs";
import { crowdsecFirewallBouncers, crowdsecLapiPort, crowdsecUnifiBouncers } from "./deployments.mjs";
import { createBouncerKeyInCt } from "./crowdsec-install.mjs";
import { syncUnifiCrowdsecBouncer } from "./crowdsec-unifi-bouncer-sync.mjs";

/**
 * Sync CrowdSec **firewall** bouncers onto configured systems (typically nginx-waf).
 *
 * Do not install crowdsec-nginx-bouncer (lua): it co-loads with ModSecurity and has
 * coredumped stock nginx on this fleet. Prefer crowdsec-firewall-bouncer-iptables.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.lapiUser
 * @param {string} opts.lapiHost
 * @param {number} opts.lapiVmid
 * @param {string | null} opts.lapiIp
 * @param {Record<string, unknown>} opts.crowdsec
 * @param {(line: string) => void} [opts.log]
 */
export async function syncCrowdsecBouncers(opts) {
  const log = opts.log ?? (() => {});
  const lapiPort = crowdsecLapiPort(opts.crowdsec);
  const lapiIp = typeof opts.lapiIp === "string" && opts.lapiIp.trim() ? opts.lapiIp.trim() : null;
  if (!lapiIp) {
    return { ok: false, message: "unable to resolve CrowdSec CT IP for bouncer sync", results: [] };
  }
  const bouncers = crowdsecFirewallBouncers(opts.crowdsec);
  if (!bouncers.length) {
    /** @type {Record<string, unknown>[]} */
    const uniResults = [];
    for (const ub of crowdsecUnifiBouncers(opts.crowdsec)) {
      const uni = await syncUnifiCrowdsecBouncer({
        repoRoot: opts.repoRoot,
        lapiUser: opts.lapiUser,
        lapiHost: opts.lapiHost,
        lapiVmid: opts.lapiVmid,
        lapiIp,
        crowdsec: opts.crowdsec,
        bouncer: ub,
        log,
      });
      uniResults.push(uni);
    }
    if (!uniResults.length) {
      return { ok: true, message: "no bouncers configured", results: [] };
    }
    return {
      ok: uniResults.every((r) => r.ok !== false),
      message: "bouncer sync completed",
      lapi_url: `http://${lapiIp}:${lapiPort}`,
      results: uniResults,
    };
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const b of bouncers) {
    const systemId = b.system_id;
    if (!systemId) continue;
    const sidecar = loadManualSystemSidecar(opts.repoRoot, systemId);
    const ip = primaryIpFromSystem(sidecar);
    if (!ip) {
      results.push({ ok: false, system_id: systemId, message: "missing access.nodes[0].ip in system sidecar" });
      continue;
    }
    const keyName = `fw-${systemId}`;
    const keyRes = createBouncerKeyInCt(opts.lapiUser, opts.lapiHost, opts.lapiVmid, keyName);
    if (!keyRes.ok) {
      results.push({ ok: false, system_id: systemId, message: keyRes.message });
      continue;
    }
    const apiKey = keyRes.apiKey;
    const exec = createGuestSshExec({ host: ip, log });
    // Shell script: install firewall bouncer only; strip any leftover lua nginx bouncer.
    const installScript = [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      "# Never leave the lua nginx bouncer in place — it crashes ModSecurity nginx.",
      "if dpkg -s crowdsec-nginx-bouncer >/dev/null 2>&1 || dpkg -s crowdsec-firewall-bouncer-nginx >/dev/null 2>&1; then",
      "  apt-get remove -y -qq crowdsec-nginx-bouncer crowdsec-firewall-bouncer-nginx 2>/dev/null || true",
      "  apt-get purge -y -qq crowdsec-nginx-bouncer crowdsec-firewall-bouncer-nginx 2>/dev/null || true",
      "fi",
      "rm -f /etc/nginx/conf.d/crowdsec_nginx.conf /etc/nginx/conf.d/crowdsec_nginx.conf.disabled",
      "rm -f /etc/nginx/modules-enabled/50-mod-http-lua.conf",
      "apt-get update -qq",
      "if ! dpkg -s crowdsec-firewall-bouncer-iptables >/dev/null 2>&1 && ! dpkg -s crowdsec-firewall-bouncer-nftables >/dev/null 2>&1; then",
      "  if ! command -v cscli >/dev/null 2>&1 && ! command -v crowdsec >/dev/null 2>&1; then",
      "    curl -s https://packagecloud.io/install/repositories/crowdsec/crowdsec/script.deb.sh | bash",
      "    apt-get update -qq",
      "  fi",
      "  apt-get install -y -qq crowdsec-firewall-bouncer-iptables || apt-get install -y -qq crowdsec-firewall-bouncer-nftables",
      "fi",
      "mkdir -p /etc/crowdsec/bouncers",
      "FW_CFG=/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml",
      "MODE=iptables",
      "dpkg -s crowdsec-firewall-bouncer-nftables >/dev/null 2>&1 && MODE=nftables || true",
      `cat > "$FW_CFG" <<'EOBC'`,
      "mode: MODE_PLACEHOLDER",
      "update_frequency: 10s",
      `api_url: http://${lapiIp}:${lapiPort}/`,
      `api_key: ${apiKey}`,
      "EOBC",
      'sed -i "s/MODE_PLACEHOLDER/$MODE/" "$FW_CFG"',
      "systemctl enable crowdsec-firewall-bouncer 2>/dev/null || true",
      "systemctl restart crowdsec-firewall-bouncer",
      "systemctl is-active crowdsec-firewall-bouncer",
      "# If nginx is present, config must still pass and the service must stay up.",
      "if command -v nginx >/dev/null 2>&1; then",
      "  nginx -t",
      "  if ! systemctl is-active --quiet nginx; then",
      "    systemctl reset-failed nginx || true",
      "    systemctl start nginx || true",
      "  fi",
      "  if ! systemctl is-active --quiet nginx; then",
      "    echo 'nginx not active after firewall-bouncer sync' >&2",
      "    exit 1",
      "  fi",
      "fi",
    ].join("\n");
    const r = exec.run(installScript, { capture: true });
    if (r.status !== 0) {
      const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
      results.push({ ok: false, system_id: systemId, ip, message: detail });
      continue;
    }
    results.push({
      ok: true,
      system_id: systemId,
      ip,
      ssh_user: exec.effectiveUser,
      fallback_used: exec.fallback_used,
      message: "firewall bouncer synced",
      bouncer_type: "firewall",
    });
  }

  for (const ub of crowdsecUnifiBouncers(opts.crowdsec)) {
    const uni = await syncUnifiCrowdsecBouncer({
      repoRoot: opts.repoRoot,
      lapiUser: opts.lapiUser,
      lapiHost: opts.lapiHost,
      lapiVmid: opts.lapiVmid,
      lapiIp,
      crowdsec: opts.crowdsec,
      bouncer: ub,
      log,
    });
    results.push(uni);
  }

  return {
    ok: results.every((r) => r.ok !== false),
    message: "bouncer sync completed",
    lapi_url: `http://${lapiIp}:${lapiPort}`,
    results,
  };
}
