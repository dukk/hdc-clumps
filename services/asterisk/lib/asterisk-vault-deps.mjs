import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { stdin as input, stderr as errout, env } from "node:process";

import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import {
  endpointList,
  twilioCredentialPasswordVaultKey,
  twilioCredentialUsernameVaultKey,
  twilioEnabled,
} from "./asterisk-render.mjs";

export function createAsteriskVaultAccess() {
  return createVaultAccess(
    vaultDepsFromCli({
      env,
      log: (...a) => errout.write(`${a.join(" ")}\n`),
      error: (...a) => errout.write(`${a.join(" ")}\n`),
      warn: (...a) => errout.write(`${a.join(" ")}\n`),
      defaultVaultPath,
      existsSync,
      readLineQuestion: async (q, opts) => {
        if (opts?.mask) {
          return readLineMasked(q, errout, input);
        }
        const rl = createInterface({ input, output: errout });
        try {
          return await rl.question(q);
        } finally {
          rl.close();
        }
      },
    }),
  );
}

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").VaultAccess} vault
 * @param {string} key
 */
async function tryGetVaultSecret(vault, key) {
  const fromEnv = typeof env[key] === "string" ? env[key].trim() : "";
  if (fromEnv) return fromEnv;
  try {
    return String(await vault.getSecret(key, { promptLabel: key, allowEmpty: true })).trim();
  } catch {
    return "";
  }
}

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").VaultAccess} vault
 * @param {Record<string, unknown>} asterisk
 * @param {{ required?: boolean }} [opts]
 */
export async function resolveTwilioCredentials(vault, asterisk, opts = {}) {
  const required = opts.required === true;
  if (!twilioEnabled(asterisk)) {
    return { username: "", password: "", missing: false };
  }

  const tw = /** @type {Record<string, unknown>} */ (asterisk.twilio ?? {});
  const userKey = twilioCredentialUsernameVaultKey(tw);
  const passKey = twilioCredentialPasswordVaultKey(tw);

  const username = await tryGetVaultSecret(vault, userKey);
  const password = await tryGetVaultSecret(vault, passKey);

  const missing = !username || !password;
  if (missing && required) {
    throw new Error(`Twilio credentials missing — set ${userKey} and ${passKey} in vault`);
  }
  if (missing) {
    errout.write(
      `[hdc] asterisk: warning — Twilio enabled but ${userKey}/${passKey} not set; trunk auth will be empty until secrets are configured.\n`,
    );
  }
  return { username, password, missing };
}

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").VaultAccess} vault
 * @param {Record<string, unknown>} asterisk
 */
export async function resolveEndpointPasswords(vault, asterisk) {
  /** @type {Record<string, string>} */
  const endpointPasswords = {};
  for (const ep of endpointList(asterisk)) {
    const id = typeof ep.id === "string" ? ep.id.trim() : "";
    if (!id) continue;
    const key =
      typeof ep.auth_username_vault_key === "string" && ep.auth_username_vault_key.trim()
        ? ep.auth_username_vault_key.trim()
        : `HDC_ASTERISK_EXT_${id}_PASSWORD`;
    const val = await tryGetVaultSecret(vault, key);
    if (val) endpointPasswords[key] = val;
  }
  return endpointPasswords;
}

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").VaultAccess} vault
 * @param {Record<string, unknown>} asterisk
 * @param {{ requiredTwilio?: boolean }} [opts]
 */
export async function resolveAsteriskSecrets(vault, asterisk, opts = {}) {
  const twilio = await resolveTwilioCredentials(vault, asterisk, {
    required: opts.requiredTwilio === true,
  });
  const endpointPasswords = await resolveEndpointPasswords(vault, asterisk);
  return {
    username: twilio.username,
    password: twilio.password,
    endpointPasswords,
    twilioMissing: twilio.missing,
  };
}
