import {
  findImportForConfigApp,
  normalizeGcpOauthConfig,
} from "./gcp-oauth-config.mjs";
import { diffApplication } from "./gcp-oauth-diff.mjs";
import { loadImportFile } from "./gcp-oauth-import.mjs";
import { resolveEffectiveApplication } from "./gcp-oauth-validate.mjs";
import { checkVaultKeysPresent } from "./vault-deps.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<typeof normalizeGcpOauthConfig>} opts.config
 * @param {string | undefined} opts.appFilterId
 * @param {string | undefined} opts.importPath
 * @param {boolean} opts.noDerive
 * @param {boolean} opts.requireVault
 * @param {ReturnType<typeof import('./vault-deps.mjs').createGcpOauthVaultAccess>} opts.vault
 * @param {(msg: string) => void} [opts.warn]
 */
export async function collectGcpOauthState(opts) {
  const { config, appFilterId, importPath, noDerive, requireVault, vault } = opts;
  const warn = opts.warn ?? (() => {});

  let apps = config.applications;
  if (appFilterId) {
    const one = config.applicationsById.get(appFilterId);
    if (!one) throw new Error(`Application not in config applications[]: ${appFilterId}`);
    apps = [one];
  }

  /** @type {import('./gcp-oauth-import.mjs').NormalizedImportClient[]} */
  let importClients = [];
  if (importPath) {
    importClients = loadImportFile(importPath);
  }

  /** @type {object[]} */
  const applications = [];
  let anyDrift = false;
  let anyVaultMissing = false;

  for (const cfgApp of apps) {
    const effective = resolveEffectiveApplication(cfgApp, {
      noDerive,
      warn,
    });
    const liveImport = importClients.length
      ? findImportForConfigApp(cfgApp, importClients)
      : null;
    const drift = diffApplication({
      desired: {
        redirect_uris: effective.redirect_uris,
        javascript_origins: effective.javascript_origins,
        existing_client_id: cfgApp.existing_client_id,
      },
      live: liveImport
        ? {
            client_id: liveImport.client_id,
            redirect_uris: liveImport.redirect_uris,
            javascript_origins: liveImport.javascript_origins,
          }
        : null,
    });
    if (drift.has_drift) anyDrift = true;

    const vaultPresent = await checkVaultKeysPresent(vault, cfgApp.vault);
    if (
      requireVault &&
      (!vaultPresent.client_id_present || !vaultPresent.client_secret_present)
    ) {
      anyVaultMissing = true;
    }

    applications.push({
      config_id: cfgApp.id,
      display_name: cfgApp.display_name,
      client_type: cfgApp.client_type,
      desired: {
        redirect_uris: effective.redirect_uris,
        javascript_origins: effective.javascript_origins,
        scopes: cfgApp.scopes,
        derived: effective.derived,
      },
      live: liveImport
        ? {
            client_id: liveImport.client_id,
            redirect_uris: liveImport.redirect_uris,
            javascript_origins: liveImport.javascript_origins,
            has_client_secret: Boolean(liveImport.client_secret),
          }
        : null,
      drift,
      vault: vaultPresent,
    });
  }

  return {
    applications,
    import_client_count: importClients.length,
    has_drift: anyDrift,
    vault_incomplete: anyVaultMissing,
  };
}
