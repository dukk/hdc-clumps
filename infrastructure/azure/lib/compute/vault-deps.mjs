import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

export const VAULT_CLIENT_SECRET = "HDC_AZURE_COMPUTE_CLIENT_SECRET";

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readAzureComputeEnv(env = process.env) {
  const subscriptionId = String(env.HDC_AZURE_COMPUTE_SUBSCRIPTION_ID ?? "").trim();
  const tenantId = String(env.HDC_AZURE_COMPUTE_TENANT_ID ?? "").trim();
  const clientId = String(env.HDC_AZURE_COMPUTE_CLIENT_ID ?? "").trim();
  if (!subscriptionId) throw new Error("HDC_AZURE_COMPUTE_SUBSCRIPTION_ID is required");
  if (!tenantId) throw new Error("HDC_AZURE_COMPUTE_TENANT_ID is required");
  if (!clientId) throw new Error("HDC_AZURE_COMPUTE_CLIENT_ID is required");
  return { subscriptionId, tenantId, clientId };
}

/**
 * @returns {Promise<{ subscriptionId: string; tenantId: string; clientId: string; clientSecret: string }>}
 */
export async function resolveAzureComputeCredentials() {
  const { subscriptionId, tenantId, clientId } = readAzureComputeEnv();
  const vault = createPackageVaultAccess();
  await vault.unlock({});
  const secrets = await vault.readSecrets({ createIfMissing: false });
  const clientSecret = secrets?.[VAULT_CLIENT_SECRET];
  if (typeof clientSecret !== "string" || !clientSecret.trim()) {
    throw new Error(`${VAULT_CLIENT_SECRET} is not set in vault`);
  }
  return { subscriptionId, tenantId, clientId, clientSecret: clientSecret.trim() };
}
