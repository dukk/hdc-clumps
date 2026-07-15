import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { normalizePrivateKeyPem } from "./oci-request-sign.mjs";

export const VAULT_API_PRIVATE_KEY = "HDC_OCI_API_PRIVATE_KEY";

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readOciComputeEnv(env = process.env) {
  const tenancyOcid = String(env.HDC_OCI_TENANCY_OCID ?? "").trim();
  const userOcid = String(env.HDC_OCI_USER_OCID ?? "").trim();
  const fingerprint = String(env.HDC_OCI_FINGERPRINT ?? "").trim();
  const region = String(env.HDC_OCI_REGION ?? "").trim();
  if (!tenancyOcid) throw new Error("HDC_OCI_TENANCY_OCID is required");
  if (!userOcid) throw new Error("HDC_OCI_USER_OCID is required");
  if (!fingerprint) throw new Error("HDC_OCI_FINGERPRINT is required");
  if (!region) throw new Error("HDC_OCI_REGION is required");
  return { tenancyOcid, userOcid, fingerprint, region };
}

/**
 * @returns {Promise<import("./oci-request-sign.mjs").OciCredentials & { region: string }>}
 */
export async function resolveOciComputeCredentials() {
  const env = readOciComputeEnv();
  const vault = createPackageVaultAccess();
  await vault.unlock({});
  const raw = await vault.getSecret(VAULT_API_PRIVATE_KEY);
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${VAULT_API_PRIVATE_KEY} is not set in vault`);
  }
  return {
    ...env,
    privateKeyPem: normalizePrivateKeyPem(raw.trim()),
  };
}
