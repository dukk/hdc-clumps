import { createAzureArmTokenProvider } from "./azure-compute-auth.mjs";
import { createAzureArmClient } from "./azure-arm-api.mjs";
import { normalizeAzureComputeConfig } from "./azure-compute-config.mjs";
import { resolveAzureComputeCredentials } from "./vault-deps.mjs";

export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/azure/config.example.json";

/**
 * Extract compute section from unified azure config or legacy flat azure-compute root.
 * @param {unknown} cfgRaw
 */
export function extractComputeConfigRaw(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object" || Array.isArray(cfgRaw)) {
    return { schema_version: 1, defaults: {}, deployments: [] };
  }
  const root = /** @type {Record<string, unknown>} */ (cfgRaw);
  if (root.compute && typeof root.compute === "object" && !Array.isArray(root.compute)) {
    const compute = /** @type {Record<string, unknown>} */ (root.compute);
    return {
      schema_version: typeof root.schema_version === "number" ? root.schema_version : 1,
      defaults: compute.defaults,
      deployments: compute.deployments,
    };
  }
  if (Array.isArray(root.deployments)) {
    return {
      schema_version: typeof root.schema_version === "number" ? root.schema_version : 1,
      defaults: root.defaults,
      deployments: root.deployments,
    };
  }
  return { schema_version: 1, defaults: {}, deployments: [] };
}

/**
 * @param {unknown} cfgRaw
 */
export async function createAzureComputeRunContext(cfgRaw) {
  const config = normalizeAzureComputeConfig(extractComputeConfigRaw(cfgRaw));
  const creds = await resolveAzureComputeCredentials();
  const tokenProvider = createAzureArmTokenProvider({
    tenantId: creds.tenantId,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  const client = createAzureArmClient({
    getToken: () => tokenProvider.getAccessToken(),
    subscriptionId: creds.subscriptionId,
  });
  return {
    config,
    creds: {
      ...creds,
      getToken: () => tokenProvider.getAccessToken(),
    },
    client,
    tokenProvider,
  };
}
