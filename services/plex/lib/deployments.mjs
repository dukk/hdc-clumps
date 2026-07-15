import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const PLEX_ROLE = "plex";
const PLEX_SYSTEM_ID = deploymentSystemIdPattern(PLEX_ROLE);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function deepMerge(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (isObject(val) && isObject(target[key])) {
      deepMerge(/** @type {Record<string, unknown>} */ (target[key]), val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} entry
 */
function mergeDeploymentEntry(defaults, entry) {
  const base = structuredClone(defaults);
  deepMerge(base, entry);
  const systemId =
    typeof entry.system_id === "string" && entry.system_id.trim()
      ? entry.system_id.trim()
      : typeof base.system_id === "string" && base.system_id.trim()
        ? base.system_id.trim()
        : "";
  if (systemId) base.system_id = systemId;
  return base;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizePlexConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("plex config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("plex config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    const mode = typeof d.mode === "string" ? d.mode.trim() : "synology-package";

    if (mode !== "synology-package") {
      throw new Error(`${sid}: unsupported mode ${JSON.stringify(mode)} (only synology-package)`);
    }
    if (!PLEX_SYSTEM_ID.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match plex-<letter> for synology-package`);
    }
    const syn = isObject(d.synology) ? d.synology : {};
    const instance = typeof syn.instance === "string" ? syn.instance.trim() : "";
    if (!instance) {
      throw new Error(`${sid}: synology.instance required for synology-package (e.g. "a")`);
    }

    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (PLEX_SYSTEM_ID.test(t)) return t;
  if (/^[a-z]+$/.test(t)) return lxcSystemId(PLEX_ROLE, t);
  return undefined;
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listPlexDeploymentSummaries(cfg) {
  const { deployments } = normalizePlexConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "synology-package";
    const install = isObject(d.install) ? d.install : {};
    const plex = isObject(d.plex) ? d.plex : {};
    const port = typeof plex.port === "number" ? plex.port : Number(plex.port);
    const syn = isObject(d.synology) ? d.synology : {};
    return {
      system_id: d.system_id,
      mode,
      synology_instance: typeof syn.instance === "string" ? syn.instance : null,
      install_enabled: install.enabled !== false,
      package_name:
        typeof plex.package_name === "string" && plex.package_name.trim()
          ? plex.package_name.trim()
          : "PlexMediaServer",
      port: Number.isFinite(port) ? port : 32400,
      public_url:
        typeof plex.public_url === "string" && plex.public_url.trim()
          ? plex.public_url.trim()
          : null,
    };
  });
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 */
export function finalizeDeployment(d, skipInstallCli) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "synology-package";
  return {
    systemId: String(d.system_id),
    mode,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    synology: isObject(d.synology) ? d.synology : {},
    plex: isObject(d.plex) ? d.plex : {},
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolvePlexDeployments(cfg, flags) {
  const { deployments } = normalizePlexConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(d, skipInstallCli)];
  }

  if (!selectedId) {
    return deployments.map((d) => finalizeDeployment(d, skipInstallCli));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(d, skipInstallCli)];
}
