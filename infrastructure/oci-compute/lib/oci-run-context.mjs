import { normalizeOciComputeConfig } from "./oci-config.mjs";
import { createOciClient } from "./oci-api.mjs";
import { resolveOciComputeCredentials } from "./vault-deps.mjs";

export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/oci-compute/config.example.json";

/**
 * @param {unknown} cfgRaw
 */
export async function createOciComputeRunContext(cfgRaw) {
  const config = normalizeOciComputeConfig(cfgRaw);
  const creds = await resolveOciComputeCredentials();
  const region = config.region || creds.region;
  const client = createOciClient({
    credentials: creds,
    region,
    compartmentId: config.compartment_id,
  });
  return {
    config: { ...config, region },
    creds,
    client,
  };
}
