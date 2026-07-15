import { env, stderr as errout } from "node:process";

import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/** @deprecated Prefer per-app HDC_AZURE_ENTRA_<APP>_SECRET_VALUE */
export const AZURE_ENTRA_CLIENT_SECRET_VAULT_KEY = "HDC_AZURE_ENTRA_CLIENT_SECRET";
/** @deprecated Prefer AZURE_ENTRA_CLIENT_SECRET_VAULT_KEY */
export const AZURE_CLIENT_SECRET_VAULT_KEY = AZURE_ENTRA_CLIENT_SECRET_VAULT_KEY;
const LEGACY_CLIENT_SECRET_VAULT_KEY = "HDC_AZURE_CLIENT_SECRET";
const LEGACY_ENTRA_CLIENT_ID_ENV = "HDC_AZURE_ENTRA_CLIENT_ID";
const LEGACY_AZURE_CLIENT_ID_ENV = "HDC_AZURE_CLIENT_ID";

export const DEFAULT_AZURE_ENTRA_AUTOMATION_APP_ID = "hdc";

/** @type {Set<string>} */
const warnedLegacy = new Set();

/**
 * @param {string} canonical
 * @param {string} legacy
 * @param {string} kind
 */
function warnLegacyOnce(canonical, legacy, kind) {
  const key = `${kind}:${legacy}`;
  if (warnedLegacy.has(key)) return;
  warnedLegacy.add(key);
  errout.write(
    `[azure] warning: using legacy ${kind} ${legacy}; prefer ${canonical}\n`
  );
}

/**
 * @param {string} appId
 * @returns {string}
 */
export function entraAppEnvPrefix(appId) {
  const slug = String(appId ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  if (!slug) {
    throw new Error("entra.automation.app_id must be a non-empty string");
  }
  return `HDC_AZURE_ENTRA_${slug}`;
}

/**
 * @typedef {{
 *   app_id: string;
 *   application_id_env: string;
 *   secret_value_vault_key: string;
 *   secret_id_env: string;
 * }} EntraAutomationCreds
 */

/**
 * Resolve automation credential env/vault key names from normalized (or partial) config.
 *
 * @param {{ automation?: Partial<EntraAutomationCreds> & { app_id?: string } } | null | undefined} [config]
 * @returns {EntraAutomationCreds}
 */
export function resolveAzureAutomationKeys(config) {
  const raw = config?.automation && typeof config.automation === "object" ? config.automation : {};
  const appId =
    typeof raw.app_id === "string" && raw.app_id.trim()
      ? raw.app_id.trim()
      : DEFAULT_AZURE_ENTRA_AUTOMATION_APP_ID;
  const prefix = entraAppEnvPrefix(appId);
  return {
    app_id: appId,
    application_id_env:
      typeof raw.application_id_env === "string" && raw.application_id_env.trim()
        ? raw.application_id_env.trim()
        : `${prefix}_APPLICATION_ID`,
    secret_value_vault_key:
      typeof raw.secret_value_vault_key === "string" && raw.secret_value_vault_key.trim()
        ? raw.secret_value_vault_key.trim()
        : `${prefix}_SECRET_VALUE`,
    secret_id_env:
      typeof raw.secret_id_env === "string" && raw.secret_id_env.trim()
        ? raw.secret_id_env.trim()
        : `${prefix}_SECRET_ID`,
  };
}

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createAzureVaultAccess() {
  return createPackageVaultAccess();
}

/** @deprecated Use createAzureVaultAccess */
export const createAzureEntraVaultAccess = createAzureVaultAccess;

/**
 * @param {NodeJS.ProcessEnv} [processEnv]
 * @returns {string}
 */
export function resolveAzureTenantId(processEnv = env) {
  const canonical =
    typeof processEnv.HDC_AZURE_ENTRA_TENANT_ID === "string"
      ? processEnv.HDC_AZURE_ENTRA_TENANT_ID.trim()
      : "";
  if (canonical) return canonical;
  const legacy =
    typeof processEnv.HDC_AZURE_TENANT_ID === "string"
      ? processEnv.HDC_AZURE_TENANT_ID.trim()
      : "";
  if (legacy) {
    warnLegacyOnce("HDC_AZURE_ENTRA_TENANT_ID", "HDC_AZURE_TENANT_ID", "env");
    return legacy;
  }
  throw new Error("HDC_AZURE_ENTRA_TENANT_ID is not set in .env");
}

/**
 * Application (client) ID for Graph automation. Prefers
 * HDC_AZURE_ENTRA_<APP>_APPLICATION_ID; never uses SECRET_ID.
 *
 * @param {{ automation?: Partial<EntraAutomationCreds> } | null | undefined} [config]
 * @param {NodeJS.ProcessEnv} [processEnv]
 * @returns {string}
 */
export function resolveAzureClientId(config, processEnv = env) {
  // Backward compat: resolveAzureClientId(env) from older tests/callers.
  if (
    config &&
    typeof config === "object" &&
    !("automation" in config) &&
    ("HDC_AZURE_ENTRA_HDC_APPLICATION_ID" in config ||
      "HDC_AZURE_ENTRA_CLIENT_ID" in config ||
      "HDC_AZURE_CLIENT_ID" in config ||
      "HDC_AZURE_ENTRA_TENANT_ID" in config)
  ) {
    return resolveAzureClientId(undefined, /** @type {NodeJS.ProcessEnv} */ (config));
  }

  const keys = resolveAzureAutomationKeys(config);
  const fromApp =
    typeof processEnv[keys.application_id_env] === "string"
      ? processEnv[keys.application_id_env].trim()
      : "";
  if (fromApp) return fromApp;

  const entraLegacy =
    typeof processEnv[LEGACY_ENTRA_CLIENT_ID_ENV] === "string"
      ? processEnv[LEGACY_ENTRA_CLIENT_ID_ENV].trim()
      : "";
  if (entraLegacy) {
    warnLegacyOnce(keys.application_id_env, LEGACY_ENTRA_CLIENT_ID_ENV, "env");
    return entraLegacy;
  }

  const azureLegacy =
    typeof processEnv[LEGACY_AZURE_CLIENT_ID_ENV] === "string"
      ? processEnv[LEGACY_AZURE_CLIENT_ID_ENV].trim()
      : "";
  if (azureLegacy) {
    warnLegacyOnce(keys.application_id_env, LEGACY_AZURE_CLIENT_ID_ENV, "env");
    return azureLegacy;
  }

  throw new Error(
    `${keys.application_id_env} is not set in .env (Application/client ID from Entra app registration Overview — not the Secret ID)`
  );
}

/**
 * Optional Secret ID for operator tracking only — never used in token requests.
 *
 * @param {{ automation?: Partial<EntraAutomationCreds> } | null | undefined} [config]
 * @param {NodeJS.ProcessEnv} [processEnv]
 * @returns {string | null}
 */
export function resolveAzureSecretId(config, processEnv = env) {
  const keys = resolveAzureAutomationKeys(config);
  const raw =
    typeof processEnv[keys.secret_id_env] === "string"
      ? processEnv[keys.secret_id_env].trim()
      : "";
  return raw || null;
}

/**
 * Client secret **value** for Graph automation. Prefers vault/env
 * HDC_AZURE_ENTRA_<APP>_SECRET_VALUE; never uses SECRET_ID.
 *
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {{ automation?: Partial<EntraAutomationCreds> } | null | undefined} [config]
 * @param {NodeJS.ProcessEnv} [processEnv]
 */
export async function resolveAzureClientSecret(vault, config, processEnv = env) {
  const keys = resolveAzureAutomationKeys(config);
  await vault.unlock({});

  let secret = await vault.getSecret(keys.secret_value_vault_key);
  if (secret && String(secret).trim()) {
    return String(secret).trim();
  }

  const fromEnv =
    typeof processEnv[keys.secret_value_vault_key] === "string"
      ? processEnv[keys.secret_value_vault_key].trim()
      : "";
  if (fromEnv) {
    errout.write(
      `[azure] warning: using ${keys.secret_value_vault_key} from .env; prefer vault: node apps/hdc-cli/cli.mjs secrets set ${keys.secret_value_vault_key}\n`
    );
    return fromEnv;
  }

  secret = await vault.getSecret(AZURE_ENTRA_CLIENT_SECRET_VAULT_KEY);
  if (secret && String(secret).trim()) {
    warnLegacyOnce(
      keys.secret_value_vault_key,
      AZURE_ENTRA_CLIENT_SECRET_VAULT_KEY,
      "vault key"
    );
    return String(secret).trim();
  }

  secret = await vault.getSecret(LEGACY_CLIENT_SECRET_VAULT_KEY);
  if (secret && String(secret).trim()) {
    warnLegacyOnce(keys.secret_value_vault_key, LEGACY_CLIENT_SECRET_VAULT_KEY, "vault key");
    return String(secret).trim();
  }

  throw new Error(
    `${keys.secret_value_vault_key} is not set. Run: node apps/hdc-cli/cli.mjs secrets set ${keys.secret_value_vault_key}`
  );
}
