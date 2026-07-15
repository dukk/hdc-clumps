import { createGcpAccessTokenProvider } from "./gcp-compute-auth.mjs";
import { createGcpComputeClient } from "./gcp-compute-api.mjs";
import { normalizeGcpComputeConfig } from "./gcp-compute-config.mjs";
import { resolveGcpComputeCredentials } from "./vault-deps.mjs";

export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/gcp-compute/config.example.json";

/**
 * @param {unknown} cfgRaw
 */
export async function createGcpComputeRunContext(cfgRaw) {
  const config = normalizeGcpComputeConfig(cfgRaw);
  const creds = await resolveGcpComputeCredentials();
  const tokenProvider = createGcpAccessTokenProvider(creds.serviceAccount);
  const client = createGcpComputeClient({
    getToken: () => tokenProvider.getAccessToken(),
    projectId: creds.projectId,
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
