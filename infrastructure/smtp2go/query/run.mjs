#!/usr/bin/env node
/**
 * SMTP2GO query: diff sender domains vs config (JSON on stdout).
 *
 * Usage: hdc run infrastructure smtp2go query --
 *   [--import] [--yes] [--domain-id <id>] [--domain <fqdn>]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createSmtp2goClient } from "hdc/package/smtp2go-api.mjs";
import { normalizeSmtp2goConfig } from "hdc/package/smtp2go-config.mjs";
import { collectSmtp2goState, fetchLiveSmtp2goState } from "hdc/package/smtp2go-collect.mjs";
import {
  importSmtp2goToConfig,
  liveStateToRestrictions,
  liveStateToSenderDomains,
} from "hdc/package/smtp2go-import.mjs";
import { createSmtp2goVaultAccess, resolveSmtp2goApiKey } from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/smtp2go/config.example.json";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[smtp2go] ${line}\n`);
}

/**
 * @param {string} question
 */
async function confirm(question) {
  const rl = createInterface({ input, output: errout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  log(`${verb}: starting`);
  const flags = parseArgvFlags(process.argv.slice(2));
  const domainId = flagGet(flags, "domain-id");
  const domainFqdn = flagGet(flags, "domain");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";

  if (doImport) {
    log(
      "import: will replace sender_domains[], ip_allow_list, and allowed_senders in config.json from live API."
    );
  }

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  let config = normalizeSmtp2goConfig(cfgRaw);
  const vault = createSmtp2goVaultAccess();
  const apiKey = await resolveSmtp2goApiKey(vault, config.apiKeyVaultKey);
  log(`API key loaded (${config.apiKeyVaultKey})`);

  const api = createSmtp2goClient({
    apiKey,
    apiBaseUrl: config.apiBase,
  });

  /** @type {{ sender_domain_count: number; config_rel: string } | null} */
  let importResult = null;

  const live = await fetchLiveSmtp2goState(api, log);

  if (doImport) {
    if (!yes) {
      const ok = await confirm(
        `Replace sender_domains[], ip_allow_list, and allowed_senders with live API data (${live.senderDomains.length} domain(s))? [y/N] `
      );
      if (!ok) {
        errout.write("[smtp2go] Aborted: import not confirmed (use --yes to skip prompt).\n");
        process.exitCode = 1;
        return;
      }
    }
    const written = importSmtp2goToConfig({ clumpRoot, live, log });
    importResult = {
      sender_domain_count: written.sender_domain_count,
      config_rel: written.configRel,
    };
    const sender_domains = liveStateToSenderDomains(live, config.domainsByFqdn);
    const restrictions = liveStateToRestrictions(live, cfgRaw);
    config = normalizeSmtp2goConfig({
      ...cfgRaw,
      sender_domains,
      ip_allow_list: restrictions.ip_allow_list,
      allowed_senders: restrictions.allowed_senders,
    });
    log(`import complete: ${written.configRel}`);
  }

  const state = collectSmtp2goState({
    config,
    live,
    domainIdFilter: domainId,
    domainFilter: domainFqdn,
  });

  const ok = !state.has_drift;

  const payload = {
    ok,
    verb: "query",
    package: "smtp2go",
    config_source: source,
    sender_domains: state.sender_domains,
    extra_in_live: state.extra_in_live,
    ip_allow_list: state.ip_allow_list,
    allowed_senders: state.allowed_senders,
    has_drift: state.has_drift,
    has_restrictions_drift: state.has_restrictions_drift,
    live_sender_domain_count: state.live_sender_domain_count,
    configured_sender_domain_count: state.configured_sender_domain_count,
    domain_id_filter: state.domain_id_filter,
    domain_filter: state.domain_filter,
    import: importResult,
    collected_at: new Date().toISOString(),
    summary:
      "SMTP2GO snapshot (sender domains, IP allowlist, allowed senders). Use --import --yes to bootstrap hdc-private config.",
  };

  if (state.has_drift) {
    log("warning: live account differs from config (run maintain for managed domains)");
  }
  log(`done: ${state.live_sender_domain_count} live domain(s), ${state.configured_sender_domain_count} configured`);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (state.has_drift && !doImport) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
