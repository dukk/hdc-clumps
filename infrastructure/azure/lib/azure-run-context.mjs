import { createAzureGraphTokenProvider } from "./azure-graph-auth.mjs";
import { createAzureGraphClient } from "./azure-graph-api.mjs";
import { normalizeAzureConfig } from "./azure-config.mjs";
import {
  createAzureVaultAccess,
  resolveAzureClientId,
  resolveAzureClientSecret,
  resolveAzureSecretId,
  resolveAzureTenantId,
} from "./vault-deps.mjs";

export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/azure/config.example.json";

/**
 * @param {unknown} cfgRaw
 */
export async function createAzureRunContext(cfgRaw) {
  const config = normalizeAzureConfig(cfgRaw);
  const vault = createAzureVaultAccess();
  const tenantId = resolveAzureTenantId();
  const clientId = resolveAzureClientId(config);
  const clientSecret = await resolveAzureClientSecret(vault, config);
  const secretId = resolveAzureSecretId(config);
  const tokenProvider = createAzureGraphTokenProvider({ tenantId, clientId, clientSecret });
  const api = createAzureGraphClient({
    baseUrl: config.graphBase,
    getAccessToken: () => tokenProvider.getAccessToken(),
  });
  return { config, api, tenantId, clientId, secretId };
}

/** @deprecated Use createAzureRunContext */
export const createAzureEntraRunContext = createAzureRunContext;

/**
 * @param {import('./azure-config.mjs').ConfigApplication} cfgApp
 * @param {import('./azure-graph-api.mjs').GraphApplication[]} allLive
 * @returns {import('./azure-graph-api.mjs').GraphApplication | null}
 */
export function findLiveGraphAppForConfig(cfgApp, allLive) {
  if (cfgApp.match.client_id) {
    const byClient = allLive.find((a) => a.appId === cfgApp.match.client_id);
    if (byClient) return byClient;
  }
  const name = (cfgApp.match.display_name ?? cfgApp.display_name).trim().toLowerCase();
  if (!name) return null;
  return (
    allLive.find((a) => a.displayName.trim().toLowerCase() === name) ??
    null
  );
}
