import { normalizeUriList } from "./gcp-oauth-config.mjs";

/**
 * @typedef {{
 *   redirect_uris: { missing: string[]; extra: string[] };
 *   javascript_origins: { missing: string[]; extra: string[] };
 *   client_id_mismatch: boolean;
 *   expected_client_id: string | null;
 *   live_client_id: string | null;
 * }} AppDrift
 */

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
 * @param {object} opts
 * @param {{ redirect_uris: string[]; javascript_origins: string[]; existing_client_id: string | null }} opts.desired
 * @param {{ client_id: string; redirect_uris: string[]; javascript_origins: string[] } | null} opts.live
 */
export function diffApplication(opts) {
  const { desired, live } = opts;
  const redirect = uriSetDrift(
    desired.redirect_uris,
    live?.redirect_uris ?? []
  );
  const origins = uriSetDrift(
    desired.javascript_origins,
    live?.javascript_origins ?? []
  );
  const expectedId = desired.existing_client_id?.trim() || null;
  const liveId = live?.client_id?.trim() || null;
  const clientIdMismatch = Boolean(expectedId && liveId && expectedId !== liveId);

  const hasDrift =
    redirect.missing.length > 0 ||
    redirect.extra.length > 0 ||
    origins.missing.length > 0 ||
    origins.extra.length > 0 ||
    clientIdMismatch;

  return {
    redirect_uris: redirect,
    javascript_origins: origins,
    client_id_mismatch: clientIdMismatch,
    expected_client_id: expectedId,
    live_client_id: liveId,
    has_drift: hasDrift,
  };
}
