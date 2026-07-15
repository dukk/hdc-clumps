import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { parseJsonc } from "hdc/cli/lib/json-config-preprocess.mjs";
import { formatRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { TSIG_KEY_NAME } from "./bind-render.mjs";

/** HMAC-SHA256 TSIG secret length (matches `dnssec-keygen -b 256`). */
const TSIG_SECRET_BYTES = 32;

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * New BIND TSIG secret (base64, suitable for `renderTsigKey`).
 * @returns {string}
 */
export function generateBindTsigSecret() {
  return randomBytes(TSIG_SECRET_BYTES).toString("base64");
}

/**
 * Patch bind.tsig_secret on disk without expanding $hdc.include zones.
 * @param {string} cfgPath
 * @param {string} secret
 * @param {Record<string, unknown>} [cfg] Optional expanded config to update in memory.
 */
export function writeBindTsigSecretToConfig(cfgPath, secret, cfg) {
  const onDisk = parseJsonc(readFileSync(cfgPath, "utf8"), cfgPath);
  if (!isObject(onDisk)) {
    throw new Error("bind config must be a JSON object");
  }
  if (!isObject(onDisk.bind)) {
    onDisk.bind = {};
  }
  /** @type {Record<string, unknown>} */ (onDisk.bind).tsig_secret = secret;
  writeFileSync(cfgPath, formatRepoJson(onDisk), "utf8");
  if (cfg) {
    if (!isObject(cfg.bind)) {
      cfg.bind = {};
    }
    /** @type {Record<string, unknown>} */ (cfg.bind).tsig_secret = secret;
  }
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createBindVaultAccess>} vault
 * @param {string} vaultKey
 * @param {string} secret
 */
async function ensureVaultTsig(vault, vaultKey, secret) {
  const data = await vault.readSecrets({});
  const cur = data && typeof data[vaultKey] === "string" ? data[vaultKey].trim() : "";
  if (cur !== secret) {
    await vault.setSecret(vaultKey, secret);
  }
}

/**
 * Resolve TSIG for deploy: config.json `bind.tsig_secret`, vault, or auto-generate.
 *
 * @param {object} opts
 * @param {string} opts.cfgPath
 * @param {Record<string, unknown>} opts.cfg Mutable config (updated when persisting).
 * @param {ReturnType<import("./deployments.mjs").bindGlobalSettings>} opts.global
 * @param {ReturnType<import("./vault-deps.mjs").createBindVaultAccess>} opts.vault
 * @param {boolean} [opts.regenerate] Force a new secret (`--regenerate-tsig`).
 * @param {(line: string) => void} opts.log
 * @returns {Promise<string>}
 */
export async function resolveBindTsigSecret(opts) {
  const { cfgPath, cfg, global, vault, regenerate = false, log } = opts;
  const vaultKey = global.tsigVaultKey;
  const bind = isObject(cfg.bind) ? cfg.bind : {};
  const fromConfig = typeof bind.tsig_secret === "string" ? bind.tsig_secret.trim() : "";

  await vault.unlock({});

  if (regenerate) {
    const secret = generateBindTsigSecret();
    writeBindTsigSecretToConfig(cfgPath, secret, cfg);
    await ensureVaultTsig(vault, vaultKey, secret);
    log(
      `generated new TSIG secret for key "${TSIG_KEY_NAME}"; saved to config.json (bind.tsig_secret) and vault ${vaultKey}`,
    );
    return secret;
  }

  if (fromConfig) {
    await ensureVaultTsig(vault, vaultKey, fromConfig);
    log(`TSIG secret loaded from config.json (bind.tsig_secret)`);
    return fromConfig;
  }

  const data = await vault.readSecrets({});
  const fromVault = data && typeof data[vaultKey] === "string" ? data[vaultKey].trim() : "";
  if (fromVault) {
    writeBindTsigSecretToConfig(cfgPath, fromVault, cfg);
    log(`TSIG secret loaded from vault ${vaultKey}; copied to config.json (bind.tsig_secret)`);
    return fromVault;
  }

  const secret = generateBindTsigSecret();
  writeBindTsigSecretToConfig(cfgPath, secret, cfg);
  await ensureVaultTsig(vault, vaultKey, secret);
  log(
    `generated new TSIG secret for key "${TSIG_KEY_NAME}"; saved to config.json (bind.tsig_secret) and vault ${vaultKey}`,
  );
  return secret;
}
