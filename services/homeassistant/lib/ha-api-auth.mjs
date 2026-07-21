/**
 * Resolve Home Assistant API base URL and vault token for import/query.
 */

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const DEFAULT_HA_TOKEN_VAULT_KEY = "HDC_HOMEASSISTANT_TOKEN";
export const HA_HTTP_PORT = 8123;

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} cfg
 * @returns {string}
 */
export function resolveHaTokenVaultKey(cfg) {
  const ha = isObject(cfg?.homeassistant) ? cfg.homeassistant : {};
  const api = isObject(ha.api) ? ha.api : {};
  const key =
    typeof api.token_vault_key === "string" && api.token_vault_key.trim()
      ? api.token_vault_key.trim()
      : DEFAULT_HA_TOKEN_VAULT_KEY;
  return key;
}

/**
 * Prefer public_url when set; otherwise LAN guest IP:8123 from deployment.
 *
 * @param {object} deployment expandDeployment result
 * @param {Record<string, unknown>} [cfg] full package config (for root public_url fallback)
 */
export function resolveHaApiBaseUrl(deployment, cfg = {}) {
  const fromDeploy =
    deployment?.homeassistant && typeof deployment.homeassistant.publicUrl === "string"
      ? deployment.homeassistant.publicUrl.trim()
      : "";
  const haRoot = isObject(cfg.homeassistant) ? cfg.homeassistant : {};
  const fromRoot = typeof haRoot.public_url === "string" ? haRoot.public_url.trim() : "";
  const publicUrl = fromDeploy || fromRoot;
  if (publicUrl) {
    return publicUrl.replace(/\/$/, "");
  }
  const ipCidr =
    deployment?.proxmox?.qemu && typeof deployment.proxmox.qemu.ip === "string"
      ? deployment.proxmox.qemu.ip.trim()
      : "";
  const ip = ipCidr.split("/")[0]?.trim() ?? "";
  if (!ip) {
    throw new Error(
      "Home Assistant API URL: set homeassistant.public_url or proxmox.qemu.ip on the deployment",
    );
  }
  return `http://${ip}:${HA_HTTP_PORT}`;
}

/**
 * Vault keys to try when resolving the long-lived access token.
 * Configured key first, then package default, then homepage widget key.
 *
 * @param {Record<string, unknown>} cfg
 * @returns {string[]}
 */
export function haTokenVaultKeyCandidates(cfg) {
  const primary = resolveHaTokenVaultKey(cfg);
  /** @type {string[]} */
  const keys = [primary];
  for (const k of [DEFAULT_HA_TOKEN_VAULT_KEY, "HDC_HOMEPAGE_HA_TOKEN"]) {
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.cfg
 * @param {object} opts.deployment expandDeployment result
 * @param {{ getSecret: (key: string, opts?: object) => Promise<string> }} [opts.vault]
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.allowPrompt=false] when false (default for import), fail if missing instead of prompting
 */
export async function resolveHaApiAuth(opts) {
  const log = opts.log ?? (() => {});
  const allowPrompt = opts.allowPrompt === true;
  const baseUrl = resolveHaApiBaseUrl(opts.deployment, opts.cfg);
  const vault = opts.vault ?? createPackageVaultAccess();
  const candidates = haTokenVaultKeyCandidates(opts.cfg);

  for (const vaultKey of candidates) {
    log(`resolving Home Assistant token from vault ${JSON.stringify(vaultKey)} …`);
    const token = await vault.getSecret(vaultKey, {
      optional: !allowPrompt,
      promptLabel: `vault secret ${vaultKey} (HA long-lived access token)`,
    });
    if (token && String(token).trim()) {
      return { baseUrl, token: String(token).trim(), vaultKey };
    }
  }

  throw new Error(
    `Home Assistant import requires a long-lived access token. Create one in HA ` +
      `(Settings → People → Long-lived access tokens), then: hdc secrets set ${DEFAULT_HA_TOKEN_VAULT_KEY}`,
  );
}
