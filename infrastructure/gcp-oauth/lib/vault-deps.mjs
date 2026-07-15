import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";

/**
 * @returns {ReturnType<typeof createPackageVaultAccess>}
 */
export function createGcpOauthVaultAccess() {
  return createPackageVaultAccess();
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {{ client_id_key: string; client_secret_key: string }} keys
 */
export async function checkVaultKeysPresent(vault, keys) {
  try {
    await vault.unlock({});
    const clientId = await vault.getSecret(keys.client_id_key);
    const clientSecret = await vault.getSecret(keys.client_secret_key);
    return {
      client_id_key: keys.client_id_key,
      client_secret_key: keys.client_secret_key,
      client_id_present: Boolean(clientId && String(clientId).trim()),
      client_secret_present: Boolean(clientSecret && String(clientSecret).trim()),
      vault_error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      client_id_key: keys.client_id_key,
      client_secret_key: keys.client_secret_key,
      client_id_present: false,
      client_secret_present: false,
      vault_error: msg,
    };
  }
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {{ client_id_key: string; client_secret_key: string }} keys
 * @param {{ client_id: string; client_secret: string }} values
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function writeVaultForApp(vault, keys, values, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});
  if (!values.client_id?.trim()) {
    throw new Error(`${keys.client_id_key}: client_id is empty in import`);
  }
  if (dryRun) {
    log(`dry-run: would set vault ${keys.client_id_key}`);
    if (values.client_secret?.trim()) {
      log(`dry-run: would set vault ${keys.client_secret_key}`);
    } else {
      log(`dry-run: skip ${keys.client_secret_key} (no secret in import — set manually)`);
    }
    return { wrote_id: false, wrote_secret: false, dryRun: true };
  }
  await vault.unlock({});
  await vault.setSecret(keys.client_id_key, values.client_id.trim());
  log(`vault: set ${keys.client_id_key}`);
  let wroteSecret = false;
  if (values.client_secret?.trim()) {
    await vault.setSecret(keys.client_secret_key, values.client_secret.trim());
    log(`vault: set ${keys.client_secret_key}`);
    wroteSecret = true;
  }
  return { wrote_id: true, wrote_secret: wroteSecret, dryRun: false };
}
