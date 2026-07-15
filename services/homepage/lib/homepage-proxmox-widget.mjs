import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { regenerateServiceAccountTokenViaOperatorApi } from "../../../infrastructure/proxmox/lib/proxmox-service-account-api.mjs";
import {
  parsePveApiTokenSecret,
  proxmoxHostEnvSlug,
  proxmoxHostWebUiFromConfig,
  proxmoxWidgetUsernameFromToken,
  runProxmoxServiceAccountMaintain,
  serviceAccountById,
  verifyProxmoxServiceAccountToken,
} from "../../../infrastructure/proxmox/lib/proxmox-service-account-maintain.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function proxmoxWidgetEnabled(homepage) {
  const widget = homepage.proxmox_widget;
  if (!isObject(widget)) return false;
  return widget.enabled !== false && widget.enabled !== 0;
}

/**
 * @param {Record<string, unknown>} homepage
 * @returns {{ serviceAccountId: string; hosts: string[] } | null}
 */
export function proxmoxWidgetSettings(homepage) {
  if (!proxmoxWidgetEnabled(homepage)) return null;
  const widget = /** @type {Record<string, unknown>} */ (homepage.proxmox_widget);
  const serviceAccountId =
    typeof widget.service_account_id === "string" ? widget.service_account_id.trim() : "homepage";
  const hosts = Array.isArray(widget.hosts)
    ? widget.hosts.map((h) => String(h).trim()).filter(Boolean)
    : [];
  if (!serviceAccountId) return null;
  return { serviceAccountId, hosts };
}

/**
 * @param {unknown} proxmoxCfg
 * @param {string} serviceAccountId
 */
export function tokenVaultKeyForServiceAccount(proxmoxCfg, serviceAccountId) {
  const account = serviceAccountById(proxmoxCfg, serviceAccountId);
  return account?.token_vault_key ?? null;
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.proxmoxPackageRoot
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {(q: string, o?: { mask?: boolean }) => Promise<string>} [opts.readLineQuestion]
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{ lines: string[]; service_account_id: string; token_vault_key: string } | null>}
 */
export async function resolveHomepageProxmoxWidgetEnv(opts) {
  const { homepage, proxmoxPackageRoot, vaultAccess, env, spawnSync, readLineQuestion, dryRun = false } =
    opts;

  const settings = proxmoxWidgetSettings(homepage);
  if (!settings) return null;

  const proxmoxLoaded = loadClumpConfigFromClumpRoot(proxmoxPackageRoot, {
    exampleRel: "clumps/infrastructure/proxmox/config.example.json",
  });
  const proxmoxCfg = proxmoxLoaded.data;
  const account = serviceAccountById(proxmoxCfg, settings.serviceAccountId);
  if (!account) {
    throw new Error(
      `homepage.proxmox_widget.service_account_id ${JSON.stringify(settings.serviceAccountId)} not found in proxmox config provision.service_accounts[]`,
    );
  }

  const vault = vaultAccess;

  /** @param {string} vaultKey */
  async function readVaultToken(vaultKey) {
    return (await vault.getSecret(vaultKey, { optional: true })).trim();
  }

  /** @param {string} vaultKey @param {string} value */
  async function persistVaultSecret(vaultKey, value) {
    if (!value) return;
    try {
      await vault.setSecret(vaultKey, value);
    } catch {
      /* Vaultwarden sync is best-effort; local vault already holds the value. */
    }
  }

  let skipEnsure = false;
  let rawToken = dryRun ? "" : await readVaultToken(account.token_vault_key);

  if (!dryRun && rawToken && settings.hosts.length) {
    const verifyBase = proxmoxHostWebUiFromConfig(proxmoxCfg, settings.hosts[0]);
    if (verifyBase) {
      try {
        await verifyProxmoxServiceAccountToken({ baseUrl: verifyBase, tokenRaw: rawToken, env });
        skipEnsure = true;
        errout.write(
          `[hdc] homepage: Proxmox service account token OK (${JSON.stringify(account.token_vault_key)}); skipping SSH ensure.\n`,
        );
        await persistVaultSecret(account.token_vault_key, rawToken);
        const password = await readVaultToken(account.password_vault_key);
        await persistVaultSecret(account.password_vault_key, password);
      } catch (e) {
        errout.write(
          `[hdc] homepage: Proxmox token verify failed (${String(/** @type {Error} */ (e).message || e)}); trying operator API repair …\n`,
        );
        const leadHostId = settings.hosts[0];
        try {
          const apiResult = await regenerateServiceAccountTokenViaOperatorApi({
            packageRoot: proxmoxPackageRoot,
            hostId: leadHostId,
            account,
            vault,
            env,
            log: (line) => errout.write(`[hdc] homepage proxmox api: ${line}\n`),
            warn: (line) => errout.write(`[hdc] homepage proxmox api: WARN ${line}\n`),
          });
          if (apiResult.ok && apiResult.tokenRaw) {
            rawToken = apiResult.tokenRaw;
            skipEnsure = true;
            errout.write(
              `[hdc] homepage: Proxmox service account repaired via operator API (${JSON.stringify(account.token_vault_key)}).\n`,
            );
          } else {
            errout.write("[hdc] homepage: Proxmox operator API repair failed; running SSH ensure …\n");
          }
        } catch (apiErr) {
          errout.write(
            `[hdc] homepage: Proxmox operator API repair failed (${String(/** @type {Error} */ (apiErr).message || apiErr)}); running SSH ensure …\n`,
          );
        }
      }
    }
  }

  if (!skipEnsure) {
    errout.write(
      `[hdc] homepage: ensuring Proxmox service account ${JSON.stringify(settings.serviceAccountId)} …\n`,
    );

    const saResult = await runProxmoxServiceAccountMaintain({
      packageRoot: proxmoxPackageRoot,
      log: (line) => errout.write(`[hdc] homepage proxmox: ${line}\n`),
      warn: (line) => errout.write(`[hdc] homepage proxmox: WARN ${line}\n`),
      vault,
      env,
      spawnSync,
      dryRun,
      readLineQuestion,
      filterIds: [settings.serviceAccountId],
    });
    if (!saResult.ok) {
      throw new Error(`Proxmox service account ${JSON.stringify(settings.serviceAccountId)} ensure failed`);
    }
  }

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_PROXMOX_* for ${settings.serviceAccountId}`],
      service_account_id: settings.serviceAccountId,
      token_vault_key: account.token_vault_key,
    };
  }

  if (!rawToken) {
    rawToken = await readVaultToken(account.token_vault_key);
  }
  if (!rawToken) {
    throw new Error(
      `vault missing ${JSON.stringify(account.token_vault_key)} after service account ensure — run proxmox maintain`,
    );
  }
  await persistVaultSecret(account.token_vault_key, rawToken);

  const username = proxmoxWidgetUsernameFromToken(rawToken);
  const secret = parsePveApiTokenSecret(rawToken);
  if (!username || !secret) {
    throw new Error(`cannot parse Proxmox widget credentials from vault key ${JSON.stringify(account.token_vault_key)}`);
  }

  /** @type {string[]} */
  const lines = [
    `HOMEPAGE_VAR_PROXMOX_USER=${username}`,
    `HOMEPAGE_VAR_PROXMOX_SECRET=${secret}`,
  ];

  for (const hostId of settings.hosts) {
    const webUi = proxmoxHostWebUiFromConfig(proxmoxCfg, hostId);
    if (!webUi) {
      throw new Error(`proxmox host ${JSON.stringify(hostId)} not found in proxmox config for widget URL env`);
    }
    lines.push(`HOMEPAGE_VAR_PROXMOX_${proxmoxHostEnvSlug(hostId)}_URL=${webUi}`);
  }

  errout.write(
    `[hdc] homepage: Proxmox widget env ready (${settings.hosts.length} host URL(s), vault ${JSON.stringify(account.token_vault_key)}).\n`,
  );

  return {
    lines,
    service_account_id: settings.serviceAccountId,
    token_vault_key: account.token_vault_key,
  };
}
