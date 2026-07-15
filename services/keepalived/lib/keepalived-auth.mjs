import { randomBytes } from "node:crypto";

/** Keepalived VRRP auth_pass is limited to 8 characters. */
const AUTH_PASS_LENGTH = 8;

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Generate an 8-character VRRP auth_pass (keepalived limit).
 * @returns {string}
 */
export function generateKeepalivedAuthPass() {
  return randomBytes(AUTH_PASS_LENGTH)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "x")
    .slice(0, AUTH_PASS_LENGTH);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createKeepalivedVaultAccess>} vault
 * @param {string} vaultKey
 * @param {string} secret
 */
async function ensureVaultAuthPass(vault, vaultKey, secret) {
  const data = await vault.readSecrets({});
  const cur = data && typeof data[vaultKey] === "string" ? data[vaultKey].trim() : "";
  if (cur !== secret) {
    await vault.setSecret(vaultKey, secret);
  }
}

/**
 * Resolve VRRP auth_pass from vault or auto-generate on first deploy.
 *
 * @param {object} opts
 * @param {ReturnType<import("./deployments.mjs").keepalivedGlobalSettings>} opts.global
 * @param {ReturnType<import("./vault-deps.mjs").createKeepalivedVaultAccess>} opts.vault
 * @param {(line: string) => void} opts.log
 * @returns {Promise<string>}
 */
export async function resolveKeepalivedAuthPass(opts) {
  const { global, vault, log } = opts;
  const vaultKey = global.authPassVaultKey;

  await vault.unlock({});

  const data = await vault.readSecrets({});
  const fromVault = data && typeof data[vaultKey] === "string" ? data[vaultKey].trim() : "";
  if (fromVault) {
    if (fromVault.length > AUTH_PASS_LENGTH) {
      throw new Error(
        `${vaultKey} must be at most ${AUTH_PASS_LENGTH} characters for keepalived VRRP auth_pass`,
      );
    }
    return fromVault;
  }

  try {
    const secret = generateKeepalivedAuthPass();
    await ensureVaultAuthPass(vault, vaultKey, secret);
    log(`generated VRRP auth_pass and saved to vault ${vaultKey}`);
    return secret;
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    log(`vault auto-generate failed (${msg}); prompting for ${vaultKey}`);
    const prompted = String(
      await vault.getSecret(vaultKey, { promptLabel: `vault secret ${vaultKey}` }),
    ).trim();
    if (!prompted || prompted.length > AUTH_PASS_LENGTH) {
      throw new Error(
        `${vaultKey} is required and must be at most ${AUTH_PASS_LENGTH} characters`,
      );
    }
    return prompted;
  }
}
