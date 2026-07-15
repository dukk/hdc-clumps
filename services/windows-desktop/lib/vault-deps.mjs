import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";

/**
 * @param {import("hdc/cli/lib/node-cli-deps.mjs").CliDeps} deps
 */
export function createWindowsDesktopVaultAccess(deps) {
  return createVaultAccess(vaultDepsFromCli(deps));
}

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<createWindowsDesktopVaultAccess>} vault
 * @param {string} key
 * @param {(q: string, o?: { mask?: boolean }) => Promise<string>} readLineQuestion
 */
export async function resolveAdminPassword(vault, key, readLineQuestion) {
  let value = await vault.getSecret(key);
  if (!value?.trim()) {
    value = await readLineQuestion(`Vault secret ${key} (Windows admin password): `, {
      mask: true,
    });
    if (!value?.trim()) {
      throw new Error(`${key} is required for windows-desktop deploy`);
    }
    await vault.setSecret(key, value.trim());
  }
  return value.trim();
}
