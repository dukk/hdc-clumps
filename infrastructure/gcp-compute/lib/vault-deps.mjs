import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { parseServiceAccountJson } from "./gcp-compute-auth.mjs";

export const VAULT_SERVICE_ACCOUNT_JSON = "HDC_GCP_COMPUTE_SERVICE_ACCOUNT_JSON";

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readGcpComputeEnv(env = process.env) {
  const projectId = String(env.HDC_GCP_COMPUTE_PROJECT_ID ?? "").trim();
  if (!projectId) throw new Error("HDC_GCP_COMPUTE_PROJECT_ID is required");
  return { projectId };
}

/**
 * @returns {Promise<{ projectId: string; serviceAccount: import("./gcp-compute-auth.mjs").ServiceAccountJson }>}
 */
export async function resolveGcpComputeCredentials() {
  const { projectId } = readGcpComputeEnv();
  const vault = createPackageVaultAccess();
  await vault.unlock({});
  const secrets = await vault.readSecrets({ createIfMissing: false });
  const raw = secrets?.[VAULT_SERVICE_ACCOUNT_JSON];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${VAULT_SERVICE_ACCOUNT_JSON} is not set in vault`);
  }
  const serviceAccount = parseServiceAccountJson(raw.trim());
  return { projectId, serviceAccount };
}
