import { readFileSync } from "node:fs";

import { normalizeUriList } from "./gcp-oauth-config.mjs";

/**
 * @typedef {import('./gcp-oauth-config.mjs').NormalizedImportClient} NormalizedImportClient
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} block
 * @param {string | null} [fallbackProjectId]
 * @returns {NormalizedImportClient | null}
 */
function clientFromCredentialBlock(block, fallbackProjectId = null) {
  const clientId =
    typeof block.client_id === "string"
      ? block.client_id.trim()
      : typeof block.clientId === "string"
        ? block.clientId.trim()
        : "";
  if (!clientId) return null;
  const clientSecret =
    typeof block.client_secret === "string"
      ? block.client_secret.trim()
      : typeof block.clientSecret === "string"
        ? block.clientSecret.trim()
        : "";
  const projectId =
    typeof block.project_id === "string"
      ? block.project_id.trim()
      : fallbackProjectId;
  return {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: normalizeUriList(block.redirect_uris ?? block.redirectUris),
    javascript_origins: normalizeUriList(
      block.javascript_origins ?? block.javascriptOrigins
    ),
    display_name: null,
    project_id: projectId,
  };
}

/**
 * Parse Google Cloud Console OAuth client download JSON (web / installed / single or array).
 * @param {unknown} data
 * @returns {NormalizedImportClient[]}
 */
export function parseImportJson(data) {
  if (!isObject(data) && !Array.isArray(data)) {
    throw new Error("Import JSON must be an object or array");
  }

  /** @type {NormalizedImportClient[]} */
  const clients = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      clients.push(...parseImportJson(item));
    }
    return dedupeClients(clients);
  }

  const root = /** @type {Record<string, unknown>} */ (data);
  const rootProject =
    typeof root.project_id === "string" ? root.project_id.trim() : null;

  for (const key of ["web", "installed", "android", "ios", "uwp", "tv", "desktop"]) {
    if (!isObject(root[key])) continue;
    const c = clientFromCredentialBlock(/** @type {Record<string, unknown>} */ (root[key]), rootProject);
    if (c) clients.push(c);
  }

  if (typeof root.client_id === "string" && root.client_id.trim()) {
    const c = clientFromCredentialBlock(root, rootProject);
    if (c) clients.push(c);
  }

  if (isObject(root.credentials) && Array.isArray(root.credentials.oauth2)) {
    for (const item of root.credentials.oauth2) {
      if (!isObject(item)) continue;
      const c = clientFromCredentialBlock(item, rootProject);
      if (c) clients.push(c);
    }
  }

  return dedupeClients(clients);
}

/**
 * @param {NormalizedImportClient[]} clients
 */
function dedupeClients(clients) {
  const byId = new Map();
  for (const c of clients) {
    const existing = byId.get(c.client_id);
    if (!existing) {
      byId.set(c.client_id, c);
      continue;
    }
    if (!existing.client_secret && c.client_secret) existing.client_secret = c.client_secret;
    if (!existing.redirect_uris.length && c.redirect_uris.length) {
      existing.redirect_uris = c.redirect_uris;
    }
    if (!existing.javascript_origins.length && c.javascript_origins.length) {
      existing.javascript_origins = c.javascript_origins;
    }
  }
  return [...byId.values()];
}

/**
 * @param {string} importPath
 */
export function loadImportFile(importPath) {
  const raw = readFileSync(importPath, "utf8");
  const data = JSON.parse(raw);
  const clients = parseImportJson(data);
  if (!clients.length) {
    throw new Error(
      `No OAuth clients found in import file: ${importPath} (expected web/installed block with client_id)`
    );
  }
  return clients;
}
