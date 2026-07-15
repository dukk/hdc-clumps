import {
  parseHdcSiteIdFromComment,
  sitePayloadsEqual,
  siteToApiPayload,
  validateSiteConfig,
} from "./safeline-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
export function normalizeLiveSiteList(body) {
  if (Array.isArray(body)) {
    return body.filter(isObject);
  }
  if (isObject(body)) {
    if (Array.isArray(body.data)) return body.data.filter(isObject);
    if (Array.isArray(body.sites)) return body.sites.filter(isObject);
    if (Array.isArray(body.items)) return body.items.filter(isObject);
  }
  return [];
}

/**
 * @param {Record<string, unknown>} live
 */
export function liveSiteId(live) {
  const id = live.id ?? live.site_id ?? live.ID;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && id.trim()) {
    const n = Number(id);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * @param {Record<string, unknown>[]} configSites
 * @param {Record<string, unknown>[]} liveSites
 * @param {{ prune?: boolean; siteFilter?: string | null }} [opts]
 */
export function planSiteSync(configSites, liveSites, opts = {}) {
  const prune = opts.prune === true;
  const siteFilter = opts.siteFilter?.trim() || null;

  /** @type {Record<string, unknown>[]} */
  const filteredConfig = [];
  for (const site of configSites) {
    if (!isObject(site)) continue;
    validateSiteConfig(site);
    const id = String(site.id).trim();
    if (siteFilter && id !== siteFilter) continue;
    filteredConfig.push(site);
  }

  const hdcLive = liveSites
    .map((live) => ({ live, hdcId: parseHdcSiteIdFromComment(live.comment) }))
    .filter((x) => x.hdcId);

  /** @type {Map<string, { live: Record<string, unknown>; numericId: number | null }>} */
  const liveByHdcId = new Map();
  for (const { live, hdcId } of hdcLive) {
    liveByHdcId.set(hdcId, { live, numericId: liveSiteId(live) });
  }

  /** @type {{ action: string; site_id: string; live_id?: number | null; payload?: Record<string, unknown> }[]} */
  const actions = [];

  for (const site of filteredConfig) {
    const siteId = String(site.id).trim();
    const desired = siteToApiPayload(site);
    const existing = liveByHdcId.get(siteId);
    if (!existing) {
      actions.push({ action: "create", site_id: siteId, payload: desired });
      continue;
    }
    const current = {
      ports: existing.live.ports,
      server_names: existing.live.server_names,
      upstreams: existing.live.upstreams,
      comment: existing.live.comment,
      ssl: existing.live.ssl,
    };
    if (!sitePayloadsEqual(desired, current)) {
      actions.push({
        action: "update",
        site_id: siteId,
        live_id: existing.numericId,
        payload: desired,
      });
    } else {
      actions.push({ action: "unchanged", site_id: siteId, live_id: existing.numericId });
    }
  }

  if (prune && !siteFilter) {
    const configIds = new Set(filteredConfig.map((s) => String(s.id).trim()));
    for (const { live, hdcId, numericId } of hdcLive.map((x) => ({
      live: x.live,
      hdcId: x.hdcId,
      numericId: liveSiteId(x.live),
    }))) {
      if (!hdcId || configIds.has(hdcId)) continue;
      actions.push({ action: "delete", site_id: hdcId, live_id: numericId });
    }
  }

  return {
    config_count: filteredConfig.length,
    live_hdc_managed_count: hdcLive.length,
    actions,
    missing_in_live: actions.filter((a) => a.action === "create").map((a) => a.site_id),
    drifted: actions.filter((a) => a.action === "update").map((a) => a.site_id),
    extra_in_live:
      prune && !siteFilter
        ? actions.filter((a) => a.action === "delete").map((a) => a.site_id)
        : hdcLive
            .filter(({ hdcId }) => hdcId && !filteredConfig.some((s) => String(s.id).trim() === hdcId))
            .map(({ hdcId }) => hdcId),
  };
}

/**
 * @param {Record<string, unknown>[]} configSites
 * @param {Record<string, unknown>[]} liveSites
 */
export function summarizeSiteDrift(configSites, liveSites) {
  const plan = planSiteSync(configSites, liveSites, { prune: false });
  return {
    missing_in_live: plan.missing_in_live,
    extra_in_live: plan.extra_in_live,
    drifted: plan.drifted,
    in_sync: plan.actions.filter((a) => a.action === "unchanged").map((a) => a.site_id),
  };
}
