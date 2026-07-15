import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} crowdsec
 */
export function enrollKeyVaultKey(crowdsec) {
  const key =
    isObject(crowdsec) && typeof crowdsec.enroll_key_vault_key === "string"
      ? crowdsec.enroll_key_vault_key.trim()
      : "";
  return key || "HDC_CROWDSEC_ENROLL_KEY";
}

/**
 * Load or mint CrowdSec LAPI auto_registration token (min 32 chars).
 * @param {ReturnType<import("../../../lib/package-vault-access.mjs").createPackageVaultAccess>} vault
 * @param {Record<string, unknown>} crowdsec
 */
export async function resolveEnrollToken(vault, crowdsec) {
  const key = enrollKeyVaultKey(crowdsec);
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing.length >= 32) {
    errout.write(`[hdc] crowdsec: enroll token loaded from vault ${key}\n`);
    return { token: existing, vaultKey: key, generated: false };
  }
  if (existing) {
    errout.write(
      `[hdc] crowdsec: vault ${key} is shorter than 32 chars (CrowdSec auto_registration requires 32+); regenerating\n`,
    );
  }
  const generated = randomBytes(32).toString("hex");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] crowdsec: generated enroll token and saved to vault ${key}\n`);
  return { token: generated, vaultKey: key, generated: true };
}
