import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  instanceFlagToSystemId,
  instanceLetterFromSystemId,
  normalizePiHoleConfig,
} from "../../pi-hole/lib/deployments.mjs";
import { ipFromIpConfig, isObject } from "./homepage-widget-utils.mjs";

export { ipFromIpConfig };

/**
 * @param {string} letter
 */
export function piholeInstanceEnvSlug(letter) {
  return letter.trim().toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function piholeWidgetEnabled(homepage) {
  const widget = homepage.pihole_widget;
  if (!isObject(widget)) return false;
  return widget.enabled !== false && widget.enabled !== 0;
}

/**
 * @param {Record<string, unknown>} homepage
 * @returns {{ version: number; instanceLetters: string[] } | null}
 */
export function piholeWidgetSettings(homepage) {
  if (!piholeWidgetEnabled(homepage)) return null;
  const widget = /** @type {Record<string, unknown>} */ (homepage.pihole_widget);
  const versionRaw = typeof widget.version === "number" ? widget.version : Number(widget.version);
  const version = Number.isFinite(versionRaw) && versionRaw >= 5 ? Math.floor(versionRaw) : 6;
  /** @type {string[]} */
  let instanceLetters = [];
  if (Array.isArray(widget.instances)) {
    for (const inst of widget.instances) {
      const letter =
        typeof inst === "string" && inst.trim()
          ? instanceLetterFromSystemId(instanceFlagToSystemId(inst.trim()) ?? "") ||
            inst.trim().toLowerCase()
          : "";
      if (letter) instanceLetters.push(letter);
    }
  }
  return { version, instanceLetters };
}

/**
 * @param {Record<string, unknown>} piholeCfg
 * @param {string[]} instanceLetters empty = all deployments
 * @returns {{ letter: string; systemId: string; url: string; key: string }[]}
 */
export function resolvePiholeWidgetInstances(piholeCfg, instanceLetters = []) {
  const { defaults, deployments } = normalizePiHoleConfig(piholeCfg);
  const defaultPihole = isObject(defaults.pihole) ? defaults.pihole : {};
  const webpassword =
    typeof defaultPihole.webpassword === "string" ? defaultPihole.webpassword.trim() : "";
  if (!webpassword) {
    throw new Error("pi-hole defaults.pihole.webpassword required for homepage pihole_widget");
  }

  const letterFilter =
    instanceLetters.length > 0 ? new Set(instanceLetters.map((l) => l.toLowerCase())) : null;

  /** @type {{ letter: string; systemId: string; url: string; key: string }[]} */
  const out = [];
  for (const d of deployments) {
    const systemId = typeof d.system_id === "string" ? d.system_id.trim() : "";
    const letter = instanceLetterFromSystemId(systemId);
    if (!letter) continue;
    if (letterFilter && !letterFilter.has(letter)) continue;

    const px = isObject(d.proxmox) ? d.proxmox : {};
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const ipConfig = typeof lxc.ip_config === "string" ? lxc.ip_config : "";
    const ip = ipFromIpConfig(ipConfig);
    if (!ip) {
      throw new Error(
        `${systemId}: proxmox.lxc.ip_config must be a static address for homepage pihole_widget (got ${JSON.stringify(ipConfig || null)})`,
      );
    }

    const perDeployPihole = isObject(d.pihole) ? d.pihole : {};
    const key =
      typeof perDeployPihole.webpassword === "string" && perDeployPihole.webpassword.trim()
        ? perDeployPihole.webpassword.trim()
        : webpassword;

    out.push({
      letter,
      systemId,
      url: `http://${ip}`,
      key,
    });
  }

  if (out.length === 0) {
    throw new Error("homepage pihole_widget: no matching pi-hole deployments");
  }
  return out;
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.piholePackageRoot
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{ lines: string[]; version: number; instances: string[] } | null>}
 */
export async function resolveHomepagePiholeWidgetEnv(opts) {
  const { homepage, piholePackageRoot, dryRun = false } = opts;

  const settings = piholeWidgetSettings(homepage);
  if (!settings) return null;

  errout.write("[hdc] homepage: resolving Pi-hole widget env from pi-hole config …\n");

  const piholeLoaded = loadClumpConfigFromClumpRoot(piholePackageRoot, {
    exampleRel: "clumps/services/pi-hole/config.example.json",
  });
  const instances = resolvePiholeWidgetInstances(piholeLoaded.data, settings.instanceLetters);

  if (dryRun) {
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_PIHOLE_* for ${instances.map((i) => i.systemId).join(", ")}`],
      version: settings.version,
      instances: instances.map((i) => i.systemId),
    };
  }

  /** @type {string[]} */
  const lines = [];
  for (const inst of instances) {
    const slug = piholeInstanceEnvSlug(inst.letter);
    lines.push(`HOMEPAGE_VAR_PIHOLE_${slug}_URL=${inst.url}`);
    lines.push(`HOMEPAGE_VAR_PIHOLE_${slug}_KEY=${inst.key}`);
  }

  errout.write(
    `[hdc] homepage: Pi-hole widget env ready (${instances.length} instance(s), version ${settings.version}).\n`,
  );

  return {
    lines,
    version: settings.version,
    instances: instances.map((i) => i.systemId),
  };
}
