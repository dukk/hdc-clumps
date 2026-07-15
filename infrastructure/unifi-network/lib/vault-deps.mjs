import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as errout, env } from "node:process";
import { existsSync } from "node:fs";

import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import { integrationInfo } from "./unifi-api.mjs";

export const UNIFI_API_KEY_VAULT_KEY = "HDC_UNIFI_NETWORK_API_KEY";

/**
 * @returns {ReturnType<typeof createVaultAccess>}
 */
export function createUnifiVaultAccess() {
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
 * @param {ReturnType<typeof createVaultAccess>} vault
 * @param {string} base
 * @param {boolean} rejectUnauthorized
 * @param {(line: string) => void} [log]
 */
export async function resolveUnifiApiKey(vault, base, rejectUnauthorized, log = () => {}) {
  const apiKey = await vault.getSecret(UNIFI_API_KEY_VAULT_KEY, {
    promptLabel: "UniFi Network Integration API key (Settings → Control plane → Integrations)",
    verify: async (key) => {
      try {
        log("Verifying API key with GET /proxy/network/integration/v1/info …");
        const info = await integrationInfo(base, key, rejectUnauthorized);
        const ver =
          info && typeof info === "object" && !Array.isArray(info) && typeof info.applicationVersion === "string"
            ? info.applicationVersion
            : "";
        log(ver ? `Controller integration API OK (applicationVersion ${ver}).` : "Controller integration API OK.");
        return true;
      } catch (e) {
        errout.write(
          `[unifi-network] API key verification failed (${/** @type {Error} */ (e).message}). Check URL, TLS, and key permissions.\n`,
        );
        return false;
      }
    },
  });
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error(
      `${UNIFI_API_KEY_VAULT_KEY} is not set. Run: node apps/hdc-cli/cli.mjs secrets set ${UNIFI_API_KEY_VAULT_KEY}`,
    );
  }
  return String(apiKey).trim();
}
