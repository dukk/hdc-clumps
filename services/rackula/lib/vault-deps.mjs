import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { stdin as input, stderr as errout, env } from "node:process";

import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import { apiWriteTokenEnabled } from "./rackula-render.mjs";

export const RACKULA_API_WRITE_TOKEN_KEY = "HDC_RACKULA_API_WRITE_TOKEN";

export function createRackulaVaultAccess() {
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
 * @param {Record<string, unknown>} rackula
 */
export async function resolveApiWriteToken(vaultAccess, rackula) {
  if (!apiWriteTokenEnabled(rackula)) return null;
  errout.write(`[hdc] rackula: reading vault key ${RACKULA_API_WRITE_TOKEN_KEY} …\n`);
  const value = await vaultAccess.getSecret(RACKULA_API_WRITE_TOKEN_KEY);
  if (!value || !String(value).trim()) {
    throw new Error(
      `rackula.api_write_token_enabled is true but ${RACKULA_API_WRITE_TOKEN_KEY} is missing in vault`,
    );
  }
  return String(value).trim();
}
