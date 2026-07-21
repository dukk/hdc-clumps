import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { CLUMP_CONFIG_EXAMPLE, liveManifestToNormalized } from "./slack-config.mjs";

/**
 * Merge exported live manifests into config apps (preserve id/managed/notes).
 *
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {ReturnType<import('./slack-config.mjs').normalizeSlackConfig>} opts.config
 * @param {ReturnType<import('./slack-api.mjs').createSlackManifestClient>} opts.api
 * @param {(line: string) => void} [opts.log]
 */
export async function importSlackToConfig(opts) {
  const { config, api, clumpRoot } = opts;
  const log = opts.log ?? (() => {});

  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const apps = Array.isArray(cfgRaw.apps) ? [...cfgRaw.apps] : [];
  let updated = 0;

  for (const app of config.apps) {
    const appId = app.match.app_id;
    if (!appId) {
      log(`import skip ${app.id}: no match.app_id`);
      continue;
    }
    const exported = await api.exportApp(appId);
    const manifest =
      exported.manifest && typeof exported.manifest === "object"
        ? /** @type {Record<string, unknown>} */ (exported.manifest)
        : {};
    const live = liveManifestToNormalized(manifest);
    const idx = apps.findIndex((a) => a && a.id === app.id);
    if (idx < 0) continue;
    const entry = { ...apps[idx] };
    entry.display_name = live.display_name || entry.display_name;
    entry.bot_display_name = live.bot_display_name || entry.bot_display_name;
    entry.bot_scopes = live.bot_scopes.length ? live.bot_scopes : entry.bot_scopes;
    entry.match = { ...(entry.match || {}), app_id: appId };
    entry.interactivity = {
      ...(entry.interactivity || {}),
      enabled: live.interactivity_enabled,
      request_url: live.request_url || entry.interactivity?.request_url || null,
    };
    apps[idx] = entry;
    updated += 1;
    log(`import merged ${app.id}`);
  }

  const next = {
    ...cfgRaw,
    schema_version: typeof cfgRaw.schema_version === "number" ? cfgRaw.schema_version : 1,
    apps,
  };
  writeResolvedRepoJson(resolved, next, { compactArrayKeys: ["apps", "bot_scopes"] });
  log(`Wrote ${updated} app update(s) to config (${source}: ${resolved.rel}).`);

  return { ok: true, updated, config_rel: resolved.rel };
}
