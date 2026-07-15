import { stderr as errout } from "node:process";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { instanceFlagToSystemId } from "../../uptime-kuma/lib/deployments.mjs";
import { ipFromIpConfig, isObject, serviceUrlFromPublicUrlOrHostPort, widgetBlockEnabled } from "./homepage-widget-utils.mjs";

/** @param {unknown} v */
function isObjectLocal(v) {
  return isObject(v);
}

/**
 * @param {Record<string, unknown>} cfg
 */
function normalizeUptimeKumaConfig(cfg) {
  if (!isObjectLocal(cfg) || !Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("uptime-kuma config needs deployments[]");
  }
  const defaults = isObjectLocal(cfg.defaults) ? cfg.defaults : {};
  return { defaults, deployments: cfg.deployments.filter(isObjectLocal) };
}

/**
 * Env var suffix for HOMEPAGE_VAR_UPTIME_KUMA_* (empty for instance `a` = backward compatible).
 * @param {string} instance
 */
export function uptimeKumaWidgetEnvSuffix(instance) {
  const t = typeof instance === "string" ? instance.trim().toLowerCase() : "";
  if (!t || t === "a") return "";
  return t.replace(/-/g, "_").toUpperCase();
}

/**
 * @param {string} suffix
 */
function uptimeKumaEnvVarName(suffix, field) {
  const mid = suffix ? `_${suffix}_` : "_";
  return `HOMEPAGE_VAR_UPTIME_KUMA${mid}${field}`;
}

/**
 * @param {Record<string, unknown>} homepage
 * @returns {{ instanceFlags: string[]; defaultSlug: string; slugsByInstance: Record<string, string> } | null}
 */
export function uptimeKumaWidgetSettings(homepage) {
  if (!uptimeKumaWidgetEnabled(homepage)) return null;
  const widget = /** @type {Record<string, unknown>} */ (homepage.uptime_kuma_widget);
  const defaultSlug = typeof widget.slug === "string" ? widget.slug.trim() : "";
  if (!defaultSlug) {
    throw new Error(
      "homepage uptime_kuma_widget.slug is required (status page slug from Uptime Kuma URL /status/<slug>)",
    );
  }

  /** @type {string[]} */
  let instanceFlags = [];
  if (Array.isArray(widget.instances)) {
    for (const inst of widget.instances) {
      if (typeof inst === "string" && inst.trim()) instanceFlags.push(inst.trim());
    }
  }
  if (instanceFlags.length === 0) instanceFlags = ["a"];

  /** @type {Record<string, string>} */
  const slugsByInstance = {};
  if (isObject(widget.slugs)) {
    for (const [key, val] of Object.entries(widget.slugs)) {
      if (typeof val === "string" && val.trim()) slugsByInstance[key.trim().toLowerCase()] = val.trim();
    }
  }

  return { instanceFlags, defaultSlug, slugsByInstance };
}

/**
 * @param {string} instanceFlag
 * @param {string} defaultSlug
 * @param {Record<string, string>} slugsByInstance
 */
export function resolveUptimeKumaWidgetSlug(instanceFlag, defaultSlug, slugsByInstance) {
  const key = instanceFlag.trim().toLowerCase();
  return slugsByInstance[key] ?? defaultSlug;
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} deployment
 */
export function resolveUptimeKumaWidgetUrl(defaults, deployment) {
  const defaultUk = isObject(defaults.uptime_kuma) ? defaults.uptime_kuma : {};
  const deployUk = isObject(deployment.uptime_kuma) ? deployment.uptime_kuma : {};
  const merged = { ...defaultUk, ...deployUk };
  const portRaw = typeof merged.port === "number" ? merged.port : Number(merged.port);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 3001;

  const publicUrl = typeof merged.public_url === "string" ? merged.public_url.trim() : "";
  if (publicUrl) {
    return serviceUrlFromPublicUrlOrHostPort(publicUrl, "", port);
  }

  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const ip = ipFromIpConfig(typeof lxc.ip_config === "string" ? lxc.ip_config : "");
  return serviceUrlFromPublicUrlOrHostPort("", ip ?? "", port);
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>[]} deployments
 * @param {string[]} instanceFlags
 * @param {string} defaultSlug
 * @param {Record<string, string>} slugsByInstance
 * @returns {{ instanceFlag: string; systemId: string; url: string; slug: string; envSuffix: string }[]}
 */
export function resolveUptimeKumaWidgetInstances(defaults, deployments, instanceFlags, defaultSlug, slugsByInstance) {
  /** @type {{ instanceFlag: string; systemId: string; url: string; slug: string; envSuffix: string }[]} */
  const out = [];

  for (const instanceFlag of instanceFlags) {
    const systemId = instanceFlagToSystemId(instanceFlag);
    if (!systemId) {
      throw new Error(`homepage uptime_kuma_widget: invalid instance ${JSON.stringify(instanceFlag)}`);
    }
    const deployment = deployments.find((d) => d.system_id === systemId);
    if (!deployment) {
      throw new Error(`homepage uptime_kuma_widget: no uptime-kuma deployment for ${JSON.stringify(systemId)}`);
    }

    const url = resolveUptimeKumaWidgetUrl(defaults, deployment);
    if (!url) {
      throw new Error(
        `${systemId}: uptime_kuma.public_url or proxmox.lxc.ip_config required for homepage uptime_kuma_widget`,
      );
    }

    const slug = resolveUptimeKumaWidgetSlug(instanceFlag, defaultSlug, slugsByInstance);
    out.push({
      instanceFlag,
      systemId,
      url,
      slug,
      envSuffix: uptimeKumaWidgetEnvSuffix(instanceFlag),
    });
  }

  if (out.length === 0) {
    throw new Error("homepage uptime_kuma_widget: no matching uptime-kuma deployments");
  }
  return out;
}

/**
 * @param {Record<string, unknown>} homepage
 */
export function uptimeKumaWidgetEnabled(homepage) {
  return widgetBlockEnabled(homepage, "uptime_kuma_widget");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.homepage
 * @param {string} opts.uptimeKumaPackageRoot
 * @param {boolean} [opts.dryRun]
 */
export async function resolveHomepageUptimeKumaWidgetEnv(opts) {
  const { homepage, uptimeKumaPackageRoot, dryRun = false } = opts;
  const settings = uptimeKumaWidgetSettings(homepage);
  if (!settings) return null;

  errout.write("[hdc] homepage: resolving Uptime Kuma widget env …\n");

  const loaded = loadClumpConfigFromClumpRoot(uptimeKumaPackageRoot, {
    exampleRel: "clumps/services/uptime-kuma/config.example.json",
  });
  const { defaults, deployments } = normalizeUptimeKumaConfig(loaded.data);
  const instances = resolveUptimeKumaWidgetInstances(
    defaults,
    deployments,
    settings.instanceFlags,
    settings.defaultSlug,
    settings.slugsByInstance,
  );

  if (dryRun) {
    const summary = instances.map((i) => `${i.systemId} slug=${i.slug}`).join(", ");
    return {
      lines: [`# dry-run: would inject HOMEPAGE_VAR_UPTIME_KUMA_* for ${summary}`],
      instances: instances.map((i) => ({ systemId: i.systemId, url: i.url, slug: i.slug })),
    };
  }

  /** @type {string[]} */
  const lines = [];
  for (const inst of instances) {
    lines.push(`${uptimeKumaEnvVarName(inst.envSuffix, "URL")}=${inst.url}`);
    lines.push(`${uptimeKumaEnvVarName(inst.envSuffix, "SLUG")}=${inst.slug}`);
  }

  const primary = instances[0];
  errout.write(
    `[hdc] homepage: Uptime Kuma widget env ready (${instances.length} instance(s), primary ${primary.url}, slug ${JSON.stringify(primary.slug)}).\n`,
  );

  return {
    lines,
    url: primary.url,
    slug: primary.slug,
    instances: instances.map((i) => ({ systemId: i.systemId, url: i.url, slug: i.slug })),
  };
}
