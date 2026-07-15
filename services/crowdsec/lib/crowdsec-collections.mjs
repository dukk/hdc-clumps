/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} crowdsec
 * @returns {string[]}
 */
export function crowdsecCollections(crowdsec) {
  if (!isObject(crowdsec)) return [];
  const raw = crowdsec.collections;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))];
}

/**
 * @param {unknown} crowdsec
 */
export function crowdsecHubUpdateEnabled(crowdsec) {
  if (!isObject(crowdsec)) return true;
  return crowdsec.hub_update !== false && crowdsec.hub_update !== 0;
}

/**
 * @param {string[]} collections
 * @param {{ hubUpdate?: boolean }} [opts]
 */
export function buildCollectionsInstallScript(collections, opts = {}) {
  const lines = [
    "set -euo pipefail",
    "if ! command -v cscli >/dev/null 2>&1; then",
    "  echo 'cscli not found' >&2",
    "  exit 1",
    "fi",
  ];
  if (opts.hubUpdate !== false) {
    lines.push("cscli hub update -q || cscli hub update || true");
  }
  for (const name of collections) {
    const safe = name.replace(/'/g, `'\\''`);
    lines.push(`cscli collections install '${safe}' -q || cscli collections install '${safe}' || true`);
  }
  lines.push("cscli collections list -o raw 2>/dev/null || true");
  return lines.join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {import("../../../lib/pve-pct-remote.mjs").pctExec} pctExec
 * @param {Record<string, unknown>} crowdsec
 * @param {{ hubUpdate?: boolean; skip?: boolean }} [opts]
 */
export function installCrowdsecCollectionsInCt(user, pveHost, vmid, pctExec, crowdsec, opts = {}) {
  if (opts.skip) {
    return { ok: true, skipped: true, message: "collections skipped" };
  }
  const collections = crowdsecCollections(crowdsec);
  if (!collections.length) {
    return { ok: true, skipped: true, message: "no collections configured" };
  }
  const inner = buildCollectionsInstallScript(collections, {
    hubUpdate: opts.hubUpdate !== false && crowdsecHubUpdateEnabled(crowdsec),
  });
  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `collections install failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 800),
      collections,
    };
  }
  return {
    ok: true,
    skipped: false,
    message: "collections installed",
    collections,
    installed_list: r.stdout.trim() || null,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {import("../../../lib/pve-pct-remote.mjs").pctExec} pctExec
 */
export function queryCollectionsInCt(user, pveHost, vmid, pctExec) {
  const r = pctExec(user, pveHost, vmid, "cscli collections list -o json 2>/dev/null || cscli collections list", {
    capture: true,
  });
  if (r.status !== 0) {
    return { ok: false, raw: r.stderr?.trim() || null };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    const names = Array.isArray(parsed)
      ? parsed.map((row) => (typeof row?.name === "string" ? row.name : null)).filter(Boolean)
      : [];
    return { ok: true, collections: names, raw_count: names.length };
  } catch {
    return { ok: true, collections: [], raw: r.stdout.trim() };
  }
}
