import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  gatewayTokenVaultKey,
  normalizeEnvSecretEntries,
} from "./openclaw-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createOpenclawVaultAccess>} vault
 * @param {string} key
 * @param {string} label
 * @param {{ generate?: boolean }} [opts]
 */
async function loadSecret(vault, key, label, opts = {}) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] openclaw: ${label} loaded from vault ${key}\n`);
    return existing;
  }
  if (opts.generate) {
    const generated = randomBytes(32).toString("base64url");
    await vault.setSecret(key, generated);
    errout.write(`[hdc] openclaw: generated ${label} and saved to vault ${key}\n`);
    return generated;
  }
  throw new Error(`missing vault secret ${key} (${label}) — run: node apps/hdc-cli/cli.mjs secrets set ${key}`);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createOpenclawVaultAccess>} vault
 * @param {Record<string, unknown>} openclaw
 */
export async function resolveOpenclawSecrets(vault, openclaw) {
  const cfg = isObject(openclaw) ? openclaw : {};
  const gatewayKey = gatewayTokenVaultKey(cfg);
  const gatewayToken = await loadSecret(vault, gatewayKey, "gateway token", { generate: true });

  /** @type {Record<string, string>} */
  const guestEnv = {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  };

  const entries = normalizeEnvSecretEntries(cfg);
  for (const entry of entries) {
    try {
      const val = await loadSecret(vault, entry.vaultKey, entry.guestEnv, { generate: false });
      guestEnv[entry.guestEnv] = val;
    } catch (e) {
      if (entry.optional) {
        errout.write(
          `[hdc] openclaw: optional secret ${entry.vaultKey} missing — skipping ${entry.guestEnv}\n`,
        );
        continue;
      }
      throw e;
    }
  }

  return { gatewayToken, gatewayKey, guestEnv };
}
