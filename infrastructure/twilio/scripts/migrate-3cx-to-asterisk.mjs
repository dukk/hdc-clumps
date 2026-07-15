#!/usr/bin/env node
/**
 * One-off: create hdc-asterisk Elastic SIP Trunk, migrate phone numbers, delete 3CX trunk.
 * Usage: node clumps/infrastructure/twilio/scripts/migrate-3cx-to-asterisk.mjs [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stderr as errout } from "node:process";
import { join } from "node:path";

import { loadDotenv } from "hdc/cli/env.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { twilioBasicAuthHeader } from "hdc/package/twilio-api.mjs";
import {
  createTwilioVaultAccess,
  resolveTwilioCredentials,
} from "hdc/package/vault-deps.mjs";

loadDotenv(join(repoRoot(), ".env"));

const OLD_TRUNK_SID = "TKc813ea6a2bf7bce5caea98c1f830db1e";
const PHONE_NUMBER_SIDS = [
  "PN6f64b2f9b914a54f748fe4616f8c282a",
  "PN5dcccd6e54ab0d3c4093ea0484399cb4",
  "PN95819f938f49825a0e27ca980c957ff8",
  "PNabe731a673edde65cf44718fdf2ae746",
];
const WAN_IP = "99.129.209.235";
const TRUNK_FRIENDLY_NAME = "hdc-asterisk";
const TRUNK_DOMAIN = "hdc-asterisk.pstn.twilio.com";
const SIP_USERNAME = "hdc-asterisk-sip";

const dryRun = process.argv.includes("--dry-run");

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[twilio-migrate] ${line}\n`);
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {string} authHeader
 * @param {Record<string, string>} [form]
 * @param {"POST"|"DELETE"} [method]
 */
async function twilioFormRequest(baseUrl, path, authHeader, form = {}, method = "POST") {
  const url = `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "DELETE" ? undefined : body,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String(/** @type {{ message?: string }} */ (parsed).message)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return /** @type {Record<string, unknown>} */ (parsed ?? {});
}

/**
 * @param {string} key
 * @param {string} value
 */
function storeVaultSecret(key, value) {
  const cli = join(repoRoot(), "tools", "hdc", "cli.mjs");
  const r = spawnSync(process.execPath, [cli, "secrets", "set", key, "--value", value], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`secrets set ${key} failed (exit ${r.status ?? "unknown"})`);
  }
}

async function main() {
  log(dryRun ? "dry-run mode" : "starting migration");
  const vault = createTwilioVaultAccess();
  const { accountSid, authToken } = await resolveTwilioCredentials(vault);
  const authHeader = twilioBasicAuthHeader(accountSid, authToken);
  const trunkingBase = "https://trunking.twilio.com/v1";
  const apiBase = "https://api.twilio.com/2010-04-01";
  const sipPassword = randomBytes(18).toString("base64url");

  if (dryRun) {
    log(`would create trunk ${TRUNK_FRIENDLY_NAME} (${TRUNK_DOMAIN})`);
    log(`would add origination sip:${WAN_IP}:5060;region=us1 and us2`);
    log(`would create credential list with user ${SIP_USERNAME}`);
    log(`would move ${PHONE_NUMBER_SIDS.length} phone number(s)`);
    log(`would delete trunk ${OLD_TRUNK_SID}`);
    return;
  }

  log("creating Elastic SIP Trunk");
  const trunk = await twilioFormRequest(trunkingBase, "/Trunks", authHeader, {
    FriendlyName: TRUNK_FRIENDLY_NAME,
    DomainName: TRUNK_DOMAIN,
  });
  const newTrunkSid = String(trunk.sid ?? "");
  const domainName = String(trunk.domain_name ?? TRUNK_DOMAIN);
  log(`created trunk ${newTrunkSid} domain ${domainName}`);

  for (const [priority, region] of [
    [10, "us1"],
    [20, "us2"],
  ]) {
    log(`adding origination ${region}`);
    await twilioFormRequest(
      trunkingBase,
      `/Trunks/${encodeURIComponent(newTrunkSid)}/OriginationUrls`,
      authHeader,
      {
        FriendlyName: `asterisk-${region}`,
        SipUrl: `sip:${WAN_IP}:5060;region=${region}`,
        Priority: String(priority),
        Weight: "10",
        Enabled: "true",
      },
    );
  }

  log("creating SIP credential list");
  const credList = await twilioFormRequest(
    apiBase,
    `/Accounts/${encodeURIComponent(accountSid)}/SIP/CredentialLists.json`,
    authHeader,
    { FriendlyName: "hdc-asterisk" },
  );
  const credListSid = String(credList.sid ?? "");
  log(`created credential list ${credListSid}`);

  await twilioFormRequest(
    apiBase,
    `/Accounts/${encodeURIComponent(accountSid)}/SIP/CredentialLists/${encodeURIComponent(credListSid)}/Credentials.json`,
    authHeader,
    { Username: SIP_USERNAME, Password: sipPassword },
  );

  log(`attaching credential list ${credListSid}`);
  await twilioFormRequest(
    trunkingBase,
    `/Trunks/${encodeURIComponent(newTrunkSid)}/CredentialLists`,
    authHeader,
    { CredentialListSid: credListSid },
  );

  for (const pnSid of PHONE_NUMBER_SIDS) {
    log(`moving phone number ${pnSid}`);
    await twilioFormRequest(
      trunkingBase,
      `/Trunks/${encodeURIComponent(newTrunkSid)}/PhoneNumbers`,
      authHeader,
      { PhoneNumberSid: pnSid },
    );
  }

  log(`deleting old 3CX trunk ${OLD_TRUNK_SID}`);
  await twilioFormRequest(
    trunkingBase,
    `/Trunks/${encodeURIComponent(OLD_TRUNK_SID)}`,
    authHeader,
    {},
    "DELETE",
  );

  log("storing SIP credentials in vault");
  storeVaultSecret("HDC_TWILIO_SIP_USERNAME", SIP_USERNAME);
  storeVaultSecret("HDC_TWILIO_SIP_PASSWORD", sipPassword);

  log(`migration complete — termination_domain: ${domainName}`);
  errout.write(
    `${JSON.stringify({ ok: true, trunk_sid: newTrunkSid, termination_domain: domainName, sip_username: SIP_USERNAME })}\n`,
  );
}

main().catch((e) => {
  errout.write(`[twilio-migrate] failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
