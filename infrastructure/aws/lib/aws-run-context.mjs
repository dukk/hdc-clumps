import { createAwsClient } from "./aws-api.mjs";
import { normalizeAwsConfig } from "./aws-config.mjs";
import {
  createAwsVaultAccess,
  resolveAwsAccessKeyId,
  resolveAwsSecretAccessKey,
  resolveAwsSessionToken,
} from "./vault-deps.mjs";

export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/aws/config.example.json";

/**
 * @param {unknown} cfgRaw
 */
export async function createAwsRunContext(cfgRaw) {
  const config = normalizeAwsConfig(cfgRaw);
  const vault = createAwsVaultAccess();
  const accessKeyId = resolveAwsAccessKeyId();
  const secretAccessKey = await resolveAwsSecretAccessKey(vault);
  const sessionToken = await resolveAwsSessionToken(vault);
  const client = createAwsClient({
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    region: config.region,
  });
  return { config, client, vault };
}
