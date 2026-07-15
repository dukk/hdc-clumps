import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { stdin as input, stderr as errout, env } from "node:process";

import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import { normalizeUsers } from "./mosquitto-render.mjs";

export function createMosquittoVaultAccess() {
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
 * @param {Record<string, unknown>} mosquitto
 * @param {ReturnType<typeof createMosquittoVaultAccess>} vault
 */
export async function loadMosquittoUserSecrets(mosquitto, vault) {
  /** @type {Map<string, string>} */
  const secrets = new Map();
  for (const user of normalizeUsers(mosquitto)) {
    const key = user.password_vault_key;
    errout.write(`[hdc] mosquitto: loading vault ${key} …\n`);
    const value = String(await vault.getSecret(key, { promptLabel: `vault secret ${key}` })).trim();
    if (!value) {
      throw new Error(`missing vault ${key}`);
    }
    secrets.set(key, value);
  }
  return secrets;
}
