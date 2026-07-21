/**
 * Import live Home Assistant config into hdc-private (split sidecars).
 */

import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { createHaClient } from "./ha-api.mjs";
import { resolveHaApiAuth } from "./ha-api-auth.mjs";
import { collectHaImportSnapshot } from "./ha-import-collect.mjs";
import { writeHomeassistantConfig } from "./ha-config-write.mjs";

export const CLUMP_CONFIG_EXAMPLE = "clumps/services/homeassistant/config.example.json";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {object} opts.deployment expandDeployment result
 * @param {Record<string, unknown>} [opts.cfg] optional preloaded config
 * @param {{ getSecret: Function }} [opts.vault]
 * @param {(line: string) => void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl] unused; client uses global fetch
 */
export async function importHomeassistantToConfig(opts) {
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });
  const cfg = opts.cfg && isObject(opts.cfg) ? opts.cfg : cfgRaw;

  const auth = await resolveHaApiAuth({
    cfg,
    deployment: opts.deployment,
    vault: opts.vault,
    log: (line) => log(line),
  });

  log(`Home Assistant API ${auth.baseUrl}`);
  const client = createHaClient({ baseUrl: auth.baseUrl, token: auth.token });
  const snapshot = await collectHaImportSnapshot(client, (line) => log(line));

  const haRoot = isObject(cfgRaw.homeassistant) ? { ...cfgRaw.homeassistant } : {};
  const api = isObject(haRoot.api) ? { ...haRoot.api } : {};
  if (!api.token_vault_key) {
    api.token_vault_key = auth.vaultKey;
  }
  haRoot.api = api;

  const next = {
    ...cfgRaw,
    schema_version:
      typeof cfgRaw.schema_version === "number" && cfgRaw.schema_version >= 3
        ? cfgRaw.schema_version
        : 3,
    homeassistant: haRoot,
    imported: {
      imported_at: new Date().toISOString(),
      ha_version: snapshot.ha_version,
      core: snapshot.core,
      source: "rest",
      base_url: auth.baseUrl,
    },
    integrations: snapshot.integrations,
    automations: snapshot.automations,
    scripts: snapshot.scripts,
    scenes: snapshot.scenes,
  };

  const writeResult = writeHomeassistantConfig(resolved, next, { split: true });
  log(
    `Wrote import to ${source}: ${resolved.rel} (${writeResult.layout}; ` +
      `${snapshot.integrations.length} integrations, ${snapshot.automations.length} automations, ` +
      `${snapshot.scripts.length} scripts, ${snapshot.scenes.length} scenes).`,
  );

  return {
    config_rel: resolved.rel,
    layout: writeResult.layout,
    base_url: auth.baseUrl,
    vault_key: auth.vaultKey,
    imported: {
      integrations: snapshot.integrations.length,
      automations: snapshot.automations.length,
      scripts: snapshot.scripts.length,
      scenes: snapshot.scenes.length,
      ha_version: snapshot.ha_version,
    },
  };
}
