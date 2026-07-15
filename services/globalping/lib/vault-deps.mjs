import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { stdin as input, stderr as errout, env } from "node:process";

import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import { adoptionTokenVaultKey } from "./globalping-render.mjs";

export const GLOBALPING_ADOPTION_TOKEN_KEY = "HDC_GLOBALPING_ADOPTION_TOKEN";

export function createGlobalpingVaultAccess() {
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
 * @param {import("hdc/cli/lib/vault-access.mjs").VaultAccess} vaultAccess
 * @param {Record<string, unknown>} globalping
 */
export async function resolveAdoptionToken(vaultAccess, globalping) {
  const vaultKey = adoptionTokenVaultKey(globalping);
  errout.write(`[hdc] globalping: reading vault key ${vaultKey} …\n`);
  const value = await vaultAccess.getSecret(vaultKey);
  if (!value || !String(value).trim()) {
    throw new Error(
      `globalping deploy/maintain requires ${vaultKey} in vault (Globalping dashboard adoption token)`,
    );
  }
  return String(value).trim();
}
