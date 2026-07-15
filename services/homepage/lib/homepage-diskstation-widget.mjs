import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { normalizeSynologyConfig } from "../../../infrastructure/synology-nas/lib/deployments.mjs";
import {
  isObject,
  readRequiredVaultSecret,
  serviceUrlFromHostPort,
  widgetBlockEnabled,
} from "./homepage-widget-utils.mjs";

export const DEFAULT_DISKSTATION_USERNAME = "homepage-stats";
export const DEFAULT_DISKSTATION_PORT = 5000;

/** @type {Record<string, string>} */
export const DEFAULT_DISKSTATION_PASSWORD_VAULT_KEYS = {
  a: "HDC_HOMEPAGE_SYNOLOGY_NAS_A_PASSWORD",
  b: "HDC_HOMEPAGE_SYNOLOGY_NAS_B_PASSWORD",
};

/**
 * @param {string} letter
 */
export function diskstationInstanceEnvSlug(letter) {
  return letter.trim().toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function diskstationWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "diskstation_widget");
}

/**
 * @param {Record<string, unknown>} homepage
 * @returns {{ instanceLetters: string[]; port: number; usernames: Record<string, unknown> } | null}
 */
export function diskstationWidgetSettings(homepage) {
  if (!diskstationWidgetEnabled(homepage)) return null;
  const widget = /** @type {Record<string, unknown>} */ (homepage.diskstation_widget);
  const portRaw = typeof widget.port === "number" ? widget.port : Number(widget.port);
  const port =
    Number.isFinite(portRaw) && portRaw >= 1 && portRaw <= 65535 ? Math.floor(portRaw) : DEFAULT_DISKSTATION_PORT;

  /** @type {string[]} */
  let instanceLetters = [];
  if (Array.isArray(widget.instances)) {
    for (const inst of widget.instances) {
      const letter = typeof inst === "string" ? inst.trim().toLowerCase() : "";
      if (/^[a-z]$/.test(letter)) instanceLetters.push(letter);
    }
  }

  const usernames = isObject(widget.usernames) ? widget.usernames : {};
  if (instanceLetters.length === 0) {
    instanceLetters = Object.keys(DEFAULT_DISKSTATION_PASSWORD_VAULT_KEYS);
  }

  return { instanceLetters, port, usernames };
}

/**
 * @param {Record<string, unknown>} synologyCfg
 * @param {string[]} instanceLetters empty = all deployments with instance letter
 * @param {number} port
 * @param {Record<string, unknown>} usernames
 * @returns {{ letter: string; systemId: string; url: string; username: string; passwordVaultKey: string }[]}
 */
export function resolveDiskstationWidgetInstances(synologyCfg, instanceLetters, port, usernames = {}) {
  const { deployments } = normalizeSynologyConfig(synologyCfg);
  const letterFilter =
    instanceLetters.length > 0 ? new Set(instanceLetters.map((l) => l.toLowerCase())) : null;

  /** @type {{ letter: string; systemId: string; url: string; username: string; passwordVaultKey: string }[]} */
  const out = [];
  for (const d of deployments) {
    const instance = typeof d.instance === "string" ? d.instance.trim().toLowerCase() : "";
    if (!instance) continue;
    if (letterFilter && !letterFilter.has(instance)) continue;

    const ssh = isObject(d.ssh) ? d.ssh : {};
    const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
    const url = serviceUrlFromHostPort(host, port, "http");
    if (!url) {
      throw new Error(
        `${d.system_id}: ssh.host required for homepage diskstation_widget (instance ${instance})`,
      );
    }

    const usernameOverride = typeof usernames[instance] === "string" ? usernames[instance].trim() : "";
    const username = usernameOverride || DEFAULT_DISKSTATION_USERNAME;

    const passwordVaultKey = DEFAULT_DISKSTATION_PASSWORD_VAULT_KEYS[instance];
    if (!passwordVaultKey) {
      throw new Error(`homepage diskstation_widget: no default vault key for instance ${instance}`);
    }

    out.push({
      letter: instance,
      systemId: typeof d.system_id === "string" ? d.system_id.trim() : "",
      url,
      username,
      passwordVaultKey,
    });
  }

  if (out.length === 0) {
    throw new Error("homepage diskstation_widget: no matching synology-nas deployments");
  }
  return out;
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.synologyNasPackageRoot
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess} opts.vaultAccess
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageDiskstationWidgetEnv(opts) {
  const { homepage, synologyNasPackageRoot, vaultAccess, dryRun = false } = opts;
  const settings = diskstationWidgetSettings(homepage);
  if (!settings) return null;

  errout.write("[hdc] homepage: resolving DiskStation widget env from synology-nas config …\n");

  const loaded = loadClumpConfigFromClumpRoot(synologyNasPackageRoot, {
    exampleRel: "clumps/infrastructure/synology-nas/config.example.json",
  });
  const instances = resolveDiskstationWidgetInstances(
    loaded.data,
    settings.instanceLetters,
    settings.port,
    settings.usernames,
  );

  if (dryRun) {
    return {
      lines: [
        `# dry-run: would inject HOMEPAGE_VAR_DISKSTATION_* for ${instances.map((i) => i.systemId).join(", ")}`,
      ],
      instances: instances.map((i) => i.systemId),
    };
  }

  /** @type {string[]} */
  const lines = [];
  for (const inst of instances) {
    const slug = diskstationInstanceEnvSlug(inst.letter);
    const password = await readRequiredVaultSecret(
      vaultAccess,
      inst.passwordVaultKey,
      `homepage diskstation_widget requires DSM password in ${inst.passwordVaultKey}`,
    );
    lines.push(`HOMEPAGE_VAR_DISKSTATION_${slug}_URL=${inst.url}`);
    lines.push(`HOMEPAGE_VAR_DISKSTATION_${slug}_USERNAME=${inst.username}`);
    lines.push(`HOMEPAGE_VAR_DISKSTATION_${slug}_PASSWORD=${password}`);
  }

  errout.write(`[hdc] homepage: DiskStation widget env ready (${instances.length} instance(s)).\n`);

  return {
    lines,
    instances: instances.map((i) => i.systemId),
  };
}
