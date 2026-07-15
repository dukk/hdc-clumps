import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";

import {
  aliasAddressFromRow,
  createMailcowApiClient,
  listAliases,
  listMailboxes,
  mailboxAddressFromRow,
  parseAliasGotoList,
  reconcileMailcowAliases,
  reconcileMailcowMailboxes,
} from "./mailcow-api.mjs";
import {
  normalizeAliasList,
  normalizeDomainList,
  normalizeMailboxList,
  resolveApiBaseUrl,
} from "./mailcow-render.mjs";
import { resolveMailcowApiKey } from "./vault-secrets.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./vault-deps.mjs").createMailcowVaultAccess>} vault
 * @param {import("./mailcow-render.mjs").MailcowMailboxConfig} mailbox
 * @param {{ autoGenerate?: boolean; log?: (line: string) => void }} [opts]
 */
export async function resolveMailboxPassword(vault, mailbox, opts = {}) {
  const log = opts.log ?? (() => {});
  const key = mailbox.password_vault_key;
  await vault.unlock({});
  const data = await vault.readSecrets({});
  const existing = data && typeof data[key] === "string" ? data[key].trim() : "";
  if (existing) {
    log(`mailbox password loaded from vault ${key}`);
    return existing;
  }
  if (opts.autoGenerate !== false) {
    const generated = randomBytes(18).toString("base64url");
    await vault.setSecret(key, generated);
    log(`generated mailbox password and saved to vault ${key}`);
    return generated;
  }
  return null;
}

/**
 * @param {import("./mailcow-render.mjs").MailcowMailboxConfig[]} configured
 * @param {unknown[]} liveRows
 */
export function buildMailboxDriftFields(configured, liveRows) {
  const configuredAddresses = configured.map((m) => m.address.toLowerCase());
  const liveAddresses = Array.isArray(liveRows)
    ? liveRows.map((row) => (isObject(row) ? mailboxAddressFromRow(row) : "")).filter(Boolean)
    : [];
  const configuredSet = new Set(configuredAddresses);
  const liveSet = new Set(liveAddresses);
  return {
    configured_mailboxes: configuredAddresses,
    live_mailbox_addresses: liveAddresses,
    missing_mailboxes: configuredAddresses.filter((addr) => !liveSet.has(addr)),
    extra_mailboxes: liveAddresses.filter((addr) => !configuredSet.has(addr)),
  };
}

/**
 * @param {import("./mailcow-render.mjs").MailcowAliasConfig[]} configured
 * @param {unknown[]} liveRows
 */
export function buildAliasDriftFields(configured, liveRows) {
  const configuredAddresses = configured.map((a) => a.address.toLowerCase());
  const liveAddresses = Array.isArray(liveRows)
    ? liveRows.map((row) => (isObject(row) ? aliasAddressFromRow(row) : "")).filter(Boolean)
    : [];
  const configuredSet = new Set(configuredAddresses);
  const liveSet = new Set(liveAddresses);
  return {
    configured_aliases: configuredAddresses,
    live_alias_addresses: liveAddresses,
    missing_aliases: configuredAddresses.filter((addr) => !liveSet.has(addr)),
    extra_aliases: liveAddresses.filter((addr) => !configuredSet.has(addr)),
  };
}

/**
 * @param {Record<string, unknown>} mailcowCfg
 * @param {ReturnType<import("./vault-deps.mjs").createMailcowVaultAccess>} vault
 * @param {{
 *   skipMailboxes?: boolean;
 *   skipAliases?: boolean;
 *   prune?: boolean;
 *   rotateMailboxPasswords?: boolean;
 *   dryRun?: boolean;
 *   log?: (line: string) => void;
 *   requiredApiKey?: boolean;
 *   apiKey?: string | null;
 * }} [opts]
 */
export async function reconcileMailcowMailboxesForConfig(mailcowCfg, vault, opts = {}) {
  const log = opts.log ?? ((line) => errout.write(`[hdc] mailcow: ${line}\n`));
  const mc = isObject(mailcowCfg) ? mailcowCfg : {};
  const configuredMailboxes = normalizeMailboxList(mc);
  const configuredAliases = normalizeAliasList(mc);
  const configuredDomains = new Set(normalizeDomainList(mc).map((d) => d.name.toLowerCase()));

  /** @type {Record<string, unknown>[]} */
  let mailboxResults = [];
  /** @type {Record<string, unknown>[]} */
  let aliasResults = [];
  let mailboxesSkipped = false;
  let aliasesSkipped = false;
  let apiOk = null;
  /** @type {string | null} */
  let apiError = null;
  /** @type {Record<string, unknown> | null} */
  let mailboxSummary = null;
  /** @type {Record<string, unknown> | null} */
  let aliasSummary = null;

  const hasWork = configuredMailboxes.length > 0 || configuredAliases.length > 0;
  if (!hasWork) {
    return {
      mailbox_results: mailboxResults,
      alias_results: aliasResults,
      mailboxes_skipped: true,
      aliases_skipped: true,
      configured_mailbox_count: 0,
      configured_alias_count: 0,
      api_ok: apiOk,
      api_error: apiError,
      mailbox_reconcile_summary: mailboxSummary,
      alias_reconcile_summary: aliasSummary,
    };
  }

  if (opts.skipMailboxes && opts.skipAliases) {
    mailboxesSkipped = true;
    aliasesSkipped = true;
    log("--skip-mailboxes and --skip-aliases — mailbox/alias reconciliation skipped.");
    return {
      mailbox_results: mailboxResults,
      alias_results: aliasResults,
      mailboxes_skipped: mailboxesSkipped,
      aliases_skipped: aliasesSkipped,
      configured_mailbox_count: configuredMailboxes.length,
      configured_alias_count: configuredAliases.length,
      api_ok: apiOk,
      api_error: apiError,
      mailbox_reconcile_summary: mailboxSummary,
      alias_reconcile_summary: aliasSummary,
    };
  }

  const apiKey =
    opts.apiKey !== undefined
      ? opts.apiKey
      : await resolveMailcowApiKey(vault, mc, { required: Boolean(opts.requiredApiKey) });
  if (!apiKey) {
    mailboxesSkipped = true;
    aliasesSkipped = true;
    log(
      `WARNING: ${configuredMailboxes.length} mailbox(es) and ${configuredAliases.length} alias(es) configured but API key missing — run: node apps/hdc-cli/cli.mjs secrets set HDC_MAILCOW_API_KEY`,
    );
    return {
      mailbox_results: mailboxResults,
      alias_results: aliasResults,
      mailboxes_skipped: mailboxesSkipped,
      aliases_skipped: aliasesSkipped,
      configured_mailbox_count: configuredMailboxes.length,
      configured_alias_count: configuredAliases.length,
      api_ok: false,
      api_error: "API key not set",
      mailbox_reconcile_summary: mailboxSummary,
      alias_reconcile_summary: aliasSummary,
    };
  }

  if (opts.dryRun) {
    log("dry-run — mailbox/alias API reconciliation skipped.");
    return {
      mailbox_results: mailboxResults,
      alias_results: aliasResults,
      mailboxes_skipped: true,
      aliases_skipped: true,
      configured_mailbox_count: configuredMailboxes.length,
      configured_alias_count: configuredAliases.length,
      api_ok: true,
      api_error: null,
      mailbox_reconcile_summary: mailboxSummary,
      alias_reconcile_summary: aliasSummary,
    };
  }

  try {
    const client = createMailcowApiClient(resolveApiBaseUrl(mc), apiKey);

    if (!opts.skipMailboxes && configuredMailboxes.length > 0) {
      log(`reconciling ${configuredMailboxes.length} mailbox(es) via API …`);
      const mailboxReconcile = await reconcileMailcowMailboxes(configuredMailboxes, client, {
        log,
        prune: Boolean(opts.prune),
        rotatePasswords: Boolean(opts.rotateMailboxPasswords),
        configuredDomains,
        resolvePassword: (mailbox) =>
          resolveMailboxPassword(vault, mailbox, { log, autoGenerate: true }),
      });
      mailboxResults = mailboxReconcile.mailbox_results;
      mailboxSummary = mailboxReconcile.summary;
    } else if (opts.skipMailboxes) {
      mailboxesSkipped = true;
      log("--skip-mailboxes — mailbox reconciliation skipped.");
    }

    if (!opts.skipAliases && configuredAliases.length > 0) {
      log(`reconciling ${configuredAliases.length} alias(es) via API …`);
      const aliasReconcile = await reconcileMailcowAliases(configuredAliases, client, {
        log,
        prune: Boolean(opts.prune),
        configuredDomains,
      });
      aliasResults = aliasReconcile.alias_results;
      aliasSummary = aliasReconcile.summary;
    } else if (opts.skipAliases) {
      aliasesSkipped = true;
      log("--skip-aliases — alias reconciliation skipped.");
    }

    apiOk = true;
  } catch (e) {
    apiOk = false;
    apiError = String(/** @type {Error} */ (e).message || e);
    log(`mailbox/alias reconciliation failed: ${apiError}`);
  }

  return {
    mailbox_results: mailboxResults,
    alias_results: aliasResults,
    mailboxes_skipped: mailboxesSkipped,
    aliases_skipped: aliasesSkipped,
    configured_mailbox_count: configuredMailboxes.length,
    configured_alias_count: configuredAliases.length,
    api_ok: apiOk,
    api_error: apiError,
    mailbox_reconcile_summary: mailboxSummary,
    alias_reconcile_summary: aliasSummary,
  };
}

/**
 * @param {import("./mailcow-render.mjs").MailcowMailboxConfig[]} configuredMailboxes
 * @param {unknown[]} liveMailboxRows
 * @param {import("./mailcow-render.mjs").MailcowAliasConfig[]} configuredAliases
 * @param {unknown[]} liveAliasRows
 */
export function buildMailboxAliasDriftReport(
  configuredMailboxes,
  liveMailboxRows,
  configuredAliases,
  liveAliasRows,
) {
  return {
    ...buildMailboxDriftFields(configuredMailboxes, liveMailboxRows),
    ...buildAliasDriftFields(configuredAliases, liveAliasRows),
  };
}

export {
  listMailboxes,
  listAliases,
  mailboxAddressFromRow,
  aliasAddressFromRow,
  parseAliasGotoList,
};
