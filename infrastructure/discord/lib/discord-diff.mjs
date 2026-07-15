import { normalizeTagList, normalizeUriList } from "./discord-config.mjs";

/**
 * @param {string[]} desired
 * @param {string[]} live
 */
export function uriSetDrift(desired, live) {
  const want = new Set(normalizeUriList(desired));
  const have = new Set(normalizeUriList(live));
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const extra = [];
  for (const u of want) {
    if (!have.has(u)) missing.push(u);
  }
  for (const u of have) {
    if (!want.has(u)) extra.push(u);
  }
  missing.sort();
  extra.sort();
  return { missing, extra };
}

/**
 * @param {string[]} desired
 * @param {string[]} live
 */
export function tagSetDrift(desired, live) {
  const want = new Set(normalizeTagList(desired));
  const have = new Set(normalizeTagList(live));
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const extra = [];
  for (const t of want) {
    if (!have.has(t)) missing.push(t);
  }
  for (const t of have) {
    if (!want.has(t)) extra.push(t);
  }
  missing.sort();
  extra.sort();
  return { missing, extra };
}

/**
 * @param {object} opts
 * @param {{
 *   description: string | null;
 *   redirect_uris: string[];
 *   interactions_endpoint_url: string | null;
 *   tags: string[];
 *   bot_public: boolean;
 *   bot_require_code_grant: boolean;
 * }} opts.desired
 * @param {{
 *   description: string;
 *   redirect_uris: string[];
 *   interactions_endpoint_url: string | null;
 *   tags: string[];
 *   bot_public: boolean;
 *   bot_require_code_grant: boolean;
 * } | null} opts.live
 */
export function diffApplication(opts) {
  const { desired, live } = opts;
  if (!live) {
    return {
      redirect_uris: { missing: [], extra: [] },
      tags: { missing: [], extra: [] },
      description_mismatch: false,
      interactions_endpoint_url_mismatch: false,
      bot_public_mismatch: false,
      bot_require_code_grant_mismatch: false,
      has_drift: false,
    };
  }

  const redirect = uriSetDrift(desired.redirect_uris, live.redirect_uris ?? []);
  const tags = tagSetDrift(desired.tags, live.tags ?? []);

  const desiredDescription = desired.description ?? "";
  const liveDescription = live.description ?? "";
  const descriptionMismatch = desiredDescription !== liveDescription;

  const desiredInteractions = desired.interactions_endpoint_url ?? null;
  const liveInteractions = live.interactions_endpoint_url ?? null;
  const interactionsMismatch = desiredInteractions !== liveInteractions;

  const botPublicMismatch = desired.bot_public !== live.bot_public;
  const botRequireCodeGrantMismatch = desired.bot_require_code_grant !== live.bot_require_code_grant;

  const hasDrift =
    redirect.missing.length > 0 ||
    redirect.extra.length > 0 ||
    tags.missing.length > 0 ||
    tags.extra.length > 0 ||
    descriptionMismatch ||
    interactionsMismatch ||
    botPublicMismatch ||
    botRequireCodeGrantMismatch;

  return {
    redirect_uris: redirect,
    tags,
    description_mismatch: descriptionMismatch,
    interactions_endpoint_url_mismatch: interactionsMismatch,
    bot_public_mismatch: botPublicMismatch,
    bot_require_code_grant_mismatch: botRequireCodeGrantMismatch,
    has_drift: hasDrift,
  };
}

/**
 * Build PATCH body for maintain — adds missing redirect URIs without removing extras.
 * @param {object} opts
 * @param {ReturnType<typeof diffApplication>} opts.drift
 * @param {ReturnType<typeof import('./discord-config.mjs').effectiveToDesired>} opts.desired
 * @param {import('./discord-config.mjs').NormalizedLiveApplication} opts.live
 */
export function patchBodyForDrift(opts) {
  const { drift, desired, live } = opts;
  /** @type {Record<string, unknown>} */
  const patch = {};

  if (drift.description_mismatch) {
    patch.description = desired.description ?? "";
  }

  if (drift.interactions_endpoint_url_mismatch) {
    patch.interactions_endpoint_url = desired.interactions_endpoint_url;
  }

  if (drift.bot_public_mismatch) {
    patch.bot_public = desired.bot_public;
  }

  if (drift.bot_require_code_grant_mismatch) {
    patch.bot_require_code_grant = desired.bot_require_code_grant;
  }

  if (drift.tags.missing.length > 0 || drift.tags.extra.length > 0) {
    patch.tags = desired.tags;
  }

  if (drift.redirect_uris.missing.length > 0 || drift.redirect_uris.extra.length > 0) {
    const merged = normalizeUriList([...live.redirect_uris, ...desired.redirect_uris]);
    patch.redirect_uris = merged;
  }

  return patch;
}

/**
 * @param {ReturnType<typeof import('./discord-config.mjs').effectiveToDesired>} desired
 * @param {import('./discord-config.mjs').NormalizedLiveApplication} live
 * @param {ReturnType<typeof diffApplication>} drift
 */
export function appsNeedUpdate(desired, live, drift) {
  if (drift.has_drift) return true;
  return false;
}
