import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import { dbPasswordVaultKey } from "./deployments.mjs";

/**
 * Load DB password from vault or generate and persist a new one.
 * @param {ReturnType<import("./vault-deps.mjs").createSolidtimeVaultAccess>} vault
 * @param {Record<string, unknown>} solidtime
 */
export async function resolveSolidtimeDbPassword(vault, solidtime) {
  const key = dbPasswordVaultKey(solidtime);
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] solidtime: DB password loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] solidtime: generated DB password and saved to vault ${key}\n`);
  return generated;
}
