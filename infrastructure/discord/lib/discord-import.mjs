import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";
import { liveAppToConfigEntry, CLUMP_CONFIG_EXAMPLE } from "./discord-config.mjs";

export const DISCORD_COMPACT_ARRAY_KEYS = ["applications"];

/**
 * @param {import('./discord-collect.mjs').fetchLiveApplicationsForImport extends (...args: any) => Promise<infer R> ? R : never} importRows
 * @param {Record<string, unknown>[]} existingList
 */
export function importRowsToApplications(importRows, existingList) {
  const existingById = new Map(
    existingList
      .filter((a) => a && typeof a.id === "string" && a.id.trim())
      .map((a) => [String(a.id).trim(), a])
  );
  const existingByAppId = new Map(
    existingList
      .filter((a) => {
        const match = a?.match;
        return (
          match &&
          typeof match === "object" &&
          typeof match.application_id === "string" &&
          match.application_id.trim()
        );
      })
      .map((a) => [String(a.match.application_id).trim(), a])
  );

  /** @type {Record<string, unknown>[]} */
  const applications = [];

  for (const row of importRows) {
    const appId = String(row.live.id ?? "").trim();
    const existing =
      existingById.get(row.configApp.id) ??
      (appId ? existingByAppId.get(appId) : null) ??
      null;
    const entry = liveAppToConfigEntry(row.live, existing);
    if (existing && typeof existing.id === "string") {
      entry.id = existing.id;
    } else {
      entry.id = row.configApp.id;
    }
    entry.bot_token_vault_key = row.configApp.bot_token_vault_key;
    if (existing && typeof existing.managed === "boolean") {
      entry.managed = existing.managed;
    }
    applications.push(entry);
  }

  for (const existing of existingList) {
    if (!existing || typeof existing !== "object") continue;
    const id = typeof existing.id === "string" ? existing.id.trim() : "";
    if (!id) continue;
    const imported = applications.some((a) => a.id === id);
    if (!imported) {
      applications.push(existing);
    }
  }

  applications.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return applications;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {{ configApp: import('./discord-config.mjs').ConfigApplication; live: import('./discord-api.mjs').DiscordApplication }[]} opts.importRows
 * @param {(line: string) => void} [opts.log]
 */
export function importDiscordToConfig(opts) {
  const log = opts.log ?? (() => {});
  const { data: cfgRaw, resolved, source } = loadClumpConfigFromClumpRoot(opts.clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
    log: (line) => errout.write(line),
  });

  const existingList = Array.isArray(cfgRaw.applications) ? cfgRaw.applications : [];
  const applications = importRowsToApplications(opts.importRows, existingList);

  const discordRaw =
    cfgRaw.discord && typeof cfgRaw.discord === "object"
      ? { ...cfgRaw.discord }
      : { api_base_url: "https://discord.com/api/v10" };

  const defaultsRaw =
    cfgRaw.defaults && typeof cfgRaw.defaults === "object"
      ? cfgRaw.defaults
      : { managed: false };

  const next = {
    ...cfgRaw,
    schema_version: typeof cfgRaw.schema_version === "number" ? cfgRaw.schema_version : 1,
    discord: discordRaw,
    defaults: defaultsRaw,
    applications,
  };

  writeResolvedRepoJson(resolved, next, { compactArrayKeys: DISCORD_COMPACT_ARRAY_KEYS });
  log(`Wrote ${applications.length} application(s) to config (${source}: ${resolved.rel}).`);

  return {
    application_count: applications.length,
    configRel: resolved.rel,
  };
}
