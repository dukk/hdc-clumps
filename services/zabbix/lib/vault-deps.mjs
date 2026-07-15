import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { stdin as input, stderr as errout, env } from "node:process";

import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import {
  zabbixDatabase,
  zabbixDbPasswordVaultKey,
  zabbixDbRootPasswordVaultKey,
} from "./deployments.mjs";

export function createZabbixVaultAccess() {
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
 * @param {ReturnType<typeof createZabbixVaultAccess>} vault
 * @param {string} key
 */
async function loadOrGenerateSecret(vault, key) {
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    errout.write(`[hdc] zabbix: secret loaded from vault ${key}\n`);
    return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  await vault.setSecret(key, generated);
  errout.write(`[hdc] zabbix: generated secret and saved to vault ${key}\n`);
  return generated;
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof createZabbixVaultAccess>} vault
 * @param {Record<string, unknown>} zabbix
 */
export async function resolveZabbixDbSecrets(vault, zabbix) {
  const cfg = isObject(zabbix) ? zabbix : {};
  const dbKey = zabbixDbPasswordVaultKey(cfg);
  const dbPassword = await loadOrGenerateSecret(vault, dbKey);
  let dbRootPassword = dbPassword;
  if (zabbixDatabase(cfg) === "mysql") {
    const rootKey = zabbixDbRootPasswordVaultKey(cfg);
    dbRootPassword = await loadOrGenerateSecret(vault, rootKey);
  }
  return { dbPassword, dbRootPassword, dbKey };
}
