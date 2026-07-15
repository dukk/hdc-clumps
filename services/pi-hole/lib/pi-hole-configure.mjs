import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";

const SHELL_PATH_EXPORT =
  'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"';

/**
 * @param {Record<string, unknown>} pihole
 */
function upstreamDnsList(pihole) {
  const raw = Array.isArray(pihole.upstream_dns) ? pihole.upstream_dns : [];
  const list = raw.map((x) => String(x).trim()).filter(Boolean);
  return list.length ? list : ["1.1.1.1", "1.0.0.1"];
}

const PIHOLE_LISTENING_MODES = new Set(["LOCAL", "SINGLE", "ALL", "BIND"]);

/**
 * @param {Record<string, unknown>} pihole
 */
function resolveListeningMode(pihole) {
  const raw =
    typeof pihole.listening_mode === "string" && pihole.listening_mode.trim()
      ? pihole.listening_mode.trim().toUpperCase()
      : "ALL";
  if (!PIHOLE_LISTENING_MODES.has(raw)) {
    throw new Error(
      `pihole.listening_mode must be one of ${[...PIHOLE_LISTENING_MODES].join(", ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

/**
 * @param {Record<string, unknown>} pihole
 */
function localDnsRecords(pihole) {
  const raw = pihole.local_dns;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => r && typeof r === "object" && !Array.isArray(r));
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} pihole
 * @param {string} [webPassword]
 */
export function configurePiHoleInCt(user, pveHost, vmid, pihole, webPassword) {
  errout.write(`[hdc] pi-hole configure: tuning CT ${vmid} …\n`);

  const upstream = upstreamDnsList(pihole);
  const listeningMode = resolveListeningMode(pihole);
  const dnsArgs = upstream.map((d) => `'${d.replace(/'/g, `'\\''`)}'`).join(" ");
  const lines = [
    "set -euo pipefail",
    SHELL_PATH_EXPORT,
    "command -v pihole >/dev/null",
    "command -v pihole-FTL >/dev/null",
    `pihole-FTL --config dns.listeningMode ${listeningMode}`,
    `pihole -a upstream dns ${dnsArgs} 2>/dev/null || true`,
  ];

  if (webPassword) {
    const escapedPw = webPassword.replace(/'/g, `'\\''`);
    lines.push(`pihole setpassword '${escapedPw}' 2>/dev/null || pihole -a -p '${escapedPw}' 2>/dev/null || true`);
  }

  const records = localDnsRecords(pihole);
  for (const rec of records) {
    const type = typeof rec.type === "string" ? rec.type.trim().toUpperCase() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const data = typeof rec.data === "string" ? rec.data.trim() : "";
    if (type === "A" && name && data) {
      const escName = name.replace(/'/g, `'\\''`);
      const escData = data.replace(/'/g, `'\\''`);
      lines.push(`pihole -a addcustomdns '${escName}' '${escData}' 2>/dev/null || true`);
    }
  }

  lines.push(
    "pihole reloaddns 2>/dev/null || systemctl restart pihole-FTL 2>/dev/null || true",
  );
  lines.push("systemctl is-active --quiet pihole-FTL");

  const r = pctExec(user, pveHost, vmid, lines.join("\n"), { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `configure failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 500),
    };
  }
  errout.write(`[hdc] pi-hole configure: completed on CT ${vmid}.\n`);
  return { ok: true, message: "configured", upstream_dns: upstream, listening_mode: listeningMode };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function queryPiHoleStatusInCt(user, pveHost, vmid) {
  const r = pctExec(
    user,
    pveHost,
    vmid,
  [
    "set -euo pipefail",
    SHELL_PATH_EXPORT,
    "command -v pihole >/dev/null",
    "echo VERSION=$(pihole -v 2>/dev/null | head -1 | tr -d '\\r')",
    "pihole status 2>/dev/null | head -20",
    "systemctl is-active --quiet pihole-FTL",
  ].join("\n"),
    { capture: true },
  );
  if (r.status !== 0) {
    return { ok: false, message: `status query failed (exit ${r.status})` };
  }
  const versionMatch = /VERSION=(.+)/.exec(r.stdout);
  const version = versionMatch ? versionMatch[1].trim() : null;
  const blocking = /blocking is enabled/i.test(r.stdout);
  const ftlActive = /FTL is listening/i.test(r.stdout) || /Pi-hole blocking is enabled/i.test(r.stdout);
  return {
    ok: true,
    version,
    blocking_enabled: blocking,
    ftl_active: ftlActive,
    status_excerpt: r.stdout.trim().slice(0, 400),
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {{ skipCoreUpdate?: boolean }} [opts]
 */
export function maintainPiHoleInCt(user, pveHost, vmid, opts = {}) {
  errout.write(`[hdc] pi-hole maintain: gravity update on CT ${vmid} …\n`);
  const gravity = pctExec(
    user,
    pveHost,
    vmid,
    `${SHELL_PATH_EXPORT}\npihole -g -f`,
    { capture: true },
  );
  /** @type {Record<string, unknown>} */
  const result = {
    gravity: {
      ok: gravity.status === 0,
      exit_code: gravity.status,
    },
  };

  if (!opts.skipCoreUpdate) {
    errout.write(`[hdc] pi-hole maintain: core update on CT ${vmid} …\n`);
    const update = pctExec(
      user,
      pveHost,
      vmid,
      `set -euo pipefail\n${SHELL_PATH_EXPORT}\nPIHOLE_SKIP_OS_CHECK=true pihole -up`,
      { capture: true },
    );
    result.core_update = { ok: update.status === 0, exit_code: update.status };
  } else {
    result.core_update = { ok: true, skipped: true };
  }

  const ok = Boolean(result.gravity.ok) && Boolean(result.core_update.ok);
  return { ok, ...result };
}

/**
 * @param {string} ip
 * @param {string} apiToken
 */
export async function queryPiHoleApiSummary(ip, apiToken) {
  if (!ip || !apiToken) return null;
  const url = `http://${ip}/admin/api.php?summaryRaw&auth=${encodeURIComponent(apiToken)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, http_status: res.status };
    const data = await res.json();
    return {
      ok: true,
      dns_queries_today: data.dns_queries_today ?? null,
      ads_blocked_today: data.ads_blocked_today ?? null,
      domains_being_blocked: data.domains_being_blocked ?? null,
      gravity_last_updated: data.gravity_last_updated ?? null,
    };
  } catch (e) {
    return { ok: false, message: String(/** @type {Error} */ (e).message || e) };
  }
}
