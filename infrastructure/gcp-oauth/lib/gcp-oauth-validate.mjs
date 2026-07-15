import { deriveUrisFromNginxWaf } from "./derive-redirect-uris.mjs";

/**
 * @typedef {import('./gcp-oauth-config.mjs').ConfigApplication} ConfigApplication
 */

/**
 * @param {string} uri
 */
export function isAllowedRedirectUri(uri) {
  const s = String(uri).trim();
  if (!s) return false;
  if (s.includes("*")) return false;
  if (s.startsWith("https://")) return true;
  if (s.startsWith("http://localhost") || s.startsWith("http://127.0.0.1")) return true;
  return false;
}

/**
 * @param {string} origin
 */
export function isAllowedJavascriptOrigin(origin) {
  const s = String(origin).trim();
  if (!s) return false;
  if (s.includes("*")) return false;
  if (s.startsWith("https://")) return true;
  if (s.startsWith("http://localhost") || s.startsWith("http://127.0.0.1")) return true;
  return false;
}

/**
 * @param {ConfigApplication} app
 * @param {{ noDerive?: boolean; warn?: (msg: string) => void }} [opts]
 */
export function resolveEffectiveApplication(app, opts = {}) {
  const warn = opts.warn ?? (() => {});
  /** @type {string[]} */
  let redirectUris = [...app.redirect_uris];
  /** @type {string[]} */
  let javascriptOrigins = [...app.javascript_origins];
  /** @type {{ redirect_uris: string[]; javascript_origins: string[] } | null} */
  let derived = null;

  if (!opts.noDerive && app.derive_from) {
    try {
      derived = deriveUrisFromNginxWaf(app.derive_from);
      if (!redirectUris.length) {
        redirectUris = [...derived.redirect_uris];
      } else if (
        derived.redirect_uris.length &&
        JSON.stringify(redirectUris.sort()) !== JSON.stringify(derived.redirect_uris.sort())
      ) {
        warn(
          `${app.id}: explicit redirect_uris differ from nginx-waf derived URIs; using explicit`
        );
      }
      if (!javascriptOrigins.length) {
        javascriptOrigins = [...derived.javascript_origins];
      } else if (
        derived.javascript_origins.length &&
        JSON.stringify(javascriptOrigins.sort()) !==
          JSON.stringify(derived.javascript_origins.sort())
      ) {
        warn(
          `${app.id}: explicit javascript_origins differ from derived origins; using explicit`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${app.id}: derive_from failed: ${msg}`);
    }
  }

  return {
    id: app.id,
    display_name: app.display_name,
    client_type: app.client_type,
    redirect_uris: redirectUris,
    javascript_origins: javascriptOrigins,
    existing_client_id: app.existing_client_id,
    derived,
  };
}

/**
 * @param {ReturnType<typeof resolveEffectiveApplication>} effective
 */
export function validateEffectiveApplication(effective) {
  /** @type {string[]} */
  const errors = [];
  if (!effective.redirect_uris.length) {
    errors.push("at least one redirect_uri is required (explicit or derive_from)");
  }
  for (const u of effective.redirect_uris) {
    if (!isAllowedRedirectUri(u)) {
      errors.push(`invalid redirect_uri (use https or localhost): ${u}`);
    }
  }
  for (const o of effective.javascript_origins) {
    if (!isAllowedJavascriptOrigin(o)) {
      errors.push(`invalid javascript_origin: ${o}`);
    }
  }
  if (effective.client_type === "web" && !effective.javascript_origins.length) {
    errors.push("web client_type requires at least one javascript_origin");
  }
  return errors;
}
