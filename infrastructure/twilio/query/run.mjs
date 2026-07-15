#!/usr/bin/env node
/**
 * Twilio query: diff SIP trunks and phone numbers vs config (JSON on stdout).
 *
 * Usage: hdc run infrastructure twilio query --
 *   [--import] [--yes] [--trunk <id>]
 */
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createTwilioClient } from "hdc/package/twilio-api.mjs";
import { normalizeTwilioConfig } from "hdc/package/twilio-config.mjs";
import { collectTwilioState, fetchLiveTwilioState } from "hdc/package/twilio-collect.mjs";
import { importTwilioToConfig } from "hdc/package/twilio-import.mjs";
import {
  createTwilioVaultAccess,
  resolveTwilioCredentials,
} from "hdc/package/vault-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/twilio/config.example.json";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[twilio] ${line}\n`);
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
  const trunkId = flagGet(flags, "trunk");
  const doImport = flags.import === "1";
  const yes = flags.yes === "1";

  if (doImport) {
    log("import: will replace sip_trunks[] and phone_numbers[] in config.json from live API.");
  }

  const { data: cfgRaw, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    bootstrapFromExample: doImport,
    log: (line) => errout.write(line),
  });
  log(`config loaded (${source})`);

  let config = normalizeTwilioConfig(cfgRaw);
  const vault = createTwilioVaultAccess();
  const { accountSid, authToken } = await resolveTwilioCredentials(vault, {
    accountSidVaultKey: config.accountSidVaultKey,
    authTokenVaultKey: config.authTokenVaultKey,
  });
  log(`API credentials loaded (${config.accountSidVaultKey}, ${config.authTokenVaultKey})`);

  const api = createTwilioClient({
    accountSid,
    authToken,
    apiBaseUrl: config.apiBase,
    trunkingApiBaseUrl: config.trunkingApiBase,
  });

  /** @type {{ sip_trunk_count: number; phone_number_count: number; config_rel: string } | null} */
  let importResult = null;

  const live = await fetchLiveTwilioState(api, log);

  if (doImport) {
    if (!yes) {
      const ok = await confirm(
        `Replace sip_trunks[] and phone_numbers[] with ${live.sipTrunks.length} trunk(s) and ${live.phoneNumbers.length} phone number(s)? [y/N] `
      );
      if (!ok) {
        errout.write("[twilio] Aborted: import not confirmed (use --yes to skip prompt).\n");
        process.exitCode = 1;
        return;
      }
    }
    const written = importTwilioToConfig({ clumpRoot, live, log });
    importResult = {
      sip_trunk_count: written.sip_trunk_count,
      phone_number_count: written.phone_number_count,
      config_rel: written.configRel,
    };
    config = normalizeTwilioConfig({
      ...cfgRaw,
      twilio: {
        ...(cfgRaw.twilio && typeof cfgRaw.twilio === "object" ? cfgRaw.twilio : {}),
        account_sid: live.account.sid,
        friendly_name: live.account.friendly_name ?? null,
        status: live.account.status ?? null,
      },
      sip_trunks: live.sipTrunks,
      phone_numbers: live.phoneNumbers,
    });
    log(`import complete: ${written.configRel}`);
  }

  const state = collectTwilioState({
    config,
    live,
    trunkFilterId: trunkId,
  });

  const ok = !state.has_drift;

  const payload = {
    ok,
    verb: "query",
    package: "twilio",
    config_source: source,
    account: state.account,
    sip_trunks: state.sip_trunks,
    phone_numbers: state.phone_numbers,
    has_drift: state.has_drift,
    live_sip_trunk_count: state.live_sip_trunk_count,
    live_phone_number_count: state.live_phone_number_count,
    configured_sip_trunk_count: state.configured_sip_trunk_count,
    configured_phone_number_count: state.configured_phone_number_count,
    trunk_filter: trunkId ?? null,
    import: importResult,
    collected_at: new Date().toISOString(),
    summary:
      "Twilio account snapshot (SIP trunks + phone numbers). Use --import --yes to bootstrap hdc-private config.",
  };

  if (state.has_drift) {
    log("warning: live account differs from config (run with --import --yes to refresh)");
  }
  log(
    `done: ${state.live_sip_trunk_count} live trunk(s), ${state.live_phone_number_count} live phone number(s)`
  );

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (state.has_drift && !doImport) process.exitCode = 1;
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
