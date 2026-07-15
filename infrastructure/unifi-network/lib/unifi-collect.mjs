import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as errout, env } from "node:process";

import {
  HDC_TLS_INSECURE_ENV,
  hdcTlsInsecureSourceEnv,
  hdcTlsRejectUnauthorized,
} from "hdc/cli/lib/tls-insecure-env.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import {
  baseUrlFromString,
  classicPortForwards,
  integrationListSites,
  normalizeClassicSiteKey,
  resolveUniFiSiteKeys,
} from "./unifi-api.mjs";
import {
  controllerFromPackageConfig,
  importPortForwardsFromLive,
  normalizeUnifiConfig,
} from "./unifi-config.mjs";
import { createUnifiVaultAccess, resolveUnifiApiKey } from "./vault-deps.mjs";

export const SPEC_TLS_INSECURE = "HDC_UNIFI_TLS_INSECURE";
export const CLUMP_CONFIG_EXAMPLE = "clumps/infrastructure/unifi-network/config.example.json";

/**
 * @param {string} line
 */
function defaultLog(line) {
  errout.write(`[unifi-network] ${line}\n`);
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} [opts.log]
 * @param {Record<string, unknown>} [opts.cfgRaw]
 * @param {boolean} [opts.bootstrapFromExample]
 */
export async function createUnifiRunContext(opts) {
  const log = opts.log ?? defaultLog;
  const rejectUnauthorized = hdcTlsRejectUnauthorized(env, SPEC_TLS_INSECURE);
  const tlsInsecureVia = hdcTlsInsecureSourceEnv(env, SPEC_TLS_INSECURE);

  log(
    rejectUnauthorized
      ? `TLS certificate verification is ON (set ${SPEC_TLS_INSECURE}=1 or ${HDC_TLS_INSECURE_ENV}=1 if the controller uses a self-signed cert).`
      : `TLS certificate verification is OFF (${tlsInsecureVia}=1).`,
  );

  let cfgRaw = opts.cfgRaw;
  /** @type {string} */
  let configSource = "provided";
  if (!cfgRaw) {
    const loaded = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
      exampleRel: CLUMP_CONFIG_EXAMPLE,
      bootstrapFromExample: opts.bootstrapFromExample === true,
      log: (line) => errout.write(line),
    });
    cfgRaw = loaded.data;
    configSource = loaded.source;
  }

  const config = normalizeUnifiConfig(cfgRaw);

  log("Resolving controller base URL (env → config.json → prompt)…");
  /** @type {string | null} */
  let base = null;
  /** @type {string} */
  let baseProvenance = "";

  if (typeof env.HDC_UNIFI_CONTROLLER_URL === "string" && env.HDC_UNIFI_CONTROLLER_URL.trim()) {
    base = baseUrlFromString(env.HDC_UNIFI_CONTROLLER_URL);
    baseProvenance = "HDC_UNIFI_CONTROLLER_URL";
  } else if (config.controllerBaseUrl) {
    const fromCfg = controllerFromPackageConfig({ controller_base_url: config.controllerBaseUrl });
    if (fromCfg) {
      base = baseUrlFromString(fromCfg.url);
      baseProvenance = fromCfg.provenance;
    }
  }

  if (!base) {
    log("No controller URL from env or config.json; you will be prompted.");
    const rl = createInterface({ input, output: errout });
    try {
      const ans = await rl.question(
        "[unifi-network] Enter UniFi controller base URL (https://gateway-ip or hostname): ",
      );
      if (!ans || !ans.trim()) {
        throw new Error("controller URL is required");
      }
      base = baseUrlFromString(ans);
      baseProvenance = "interactive prompt";
    } finally {
      rl.close();
    }
  }

  log(`Controller base URL: ${base}`);
  log(`Controller URL source: ${baseProvenance}`);

  const vault = createUnifiVaultAccess();
  log("Checking vault for API key (passphrase may be prompted)…");
  const apiKey = await resolveUnifiApiKey(vault, base, rejectUnauthorized, log);
  log("API key loaded and verified (value not logged).");

  let preferredSiteId =
    typeof env.HDC_UNIFI_SITE_ID === "string" && env.HDC_UNIFI_SITE_ID.trim()
      ? env.HDC_UNIFI_SITE_ID.trim()
      : "";
  if (!preferredSiteId && config.defaultSiteId) {
    preferredSiteId = config.defaultSiteId;
    log(`Using default_site_id from config.json (${JSON.stringify(preferredSiteId)}).`);
  } else if (preferredSiteId) {
    log(`Using site from HDC_UNIFI_SITE_ID (${JSON.stringify(preferredSiteId)}).`);
  }

  log("Listing sites: GET /proxy/network/integration/v1/sites …");
  const sitesBody = await integrationListSites(base, apiKey, rejectUnauthorized);
  const { integrationSiteId, classicSiteKey, siteName } = resolveUniFiSiteKeys(sitesBody, preferredSiteId);
  log(
    `Resolved site integration id ${JSON.stringify(integrationSiteId)} (${siteName}); classic API site key ${JSON.stringify(classicSiteKey)}.`,
  );

  return {
    base,
    apiKey,
    siteId: integrationSiteId,
    classicSiteKey,
    rejectUnauthorized,
    config,
    configSource,
    cfgRaw: /** @type {Record<string, unknown>} */ (cfgRaw),
  };
}

/**
 * @param {ReturnType<typeof createUnifiRunContext> extends Promise<infer T> ? T : never} ctx
 * @param {(line: string) => void} [log]
 */
export async function fetchLivePortForwards(ctx, log = defaultLog) {
  const siteKey = normalizeClassicSiteKey(ctx.classicSiteKey || "default");
  log(`Listing port forwards (classic API): GET …/api/s/${siteKey}/rest/portforward …`);
  const pf = await classicPortForwards(ctx.base, ctx.apiKey, siteKey, ctx.rejectUnauthorized);
  ctx.classicSiteKey = normalizeClassicSiteKey(pf.siteKey);
  log(`Port forwards: ${pf.rows.length} (classic site key "${pf.siteKey}").`);
  return pf.rows;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {Record<string, unknown>[]} opts.liveRows
 * @param {(line: string) => void} [opts.log]
 */
export function importPortForwardsToConfig(opts) {
  const log = opts.log ?? defaultLog;
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  const imported = importPortForwardsFromLive(opts.liveRows);
  const next = { ...cfgRaw, port_forwards: imported };
  writeResolvedRepoJson(resolved, next);
  log(`Wrote ${imported.length} port forward rule(s) to config (${source}: ${resolved.rel}).`);
  return { imported, configPath: resolved.path, configRel: resolved.rel, source };
}
