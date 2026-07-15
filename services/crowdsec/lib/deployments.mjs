import { deploymentSystemIdPattern, lxcSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const CROWDSEC_ROLE = "crowdsec";

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
function normalizeV1(cfg) {
  const deploy = isObject(cfg.deploy) ? cfg.deploy : {};
  const mode = typeof deploy.mode === "string" ? deploy.mode.trim() : "";
  const systemId =
    typeof deploy.system_id === "string" && deploy.system_id.trim()
      ? deploy.system_id.trim()
      : lxcSystemId(CROWDSEC_ROLE, "a");
  /** @type {Record<string, unknown>} */
  const defaults = { mode };
  if (isObject(cfg.proxmox)) defaults.proxmox = structuredClone(cfg.proxmox);
  if (isObject(cfg.crowdsec)) defaults.crowdsec = structuredClone(cfg.crowdsec);
  if (isObject(cfg.install)) defaults.install = structuredClone(cfg.install);
  return {
    schemaVersion: 1,
    defaults,
    deployments: [{ system_id: systemId }],
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeCrowdsecConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("crowdsec config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (Array.isArray(cfg.deployments) && cfg.deployments.length > 0) {
    const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
    const raw = cfg.deployments.filter(isObject);
    if (!raw.length) {
      throw new Error("deployments[] is empty - add at least one entry");
    }
    const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
    validateDeployments(deployments);
    return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments };
  }
  if (isObject(cfg.deploy) || isObject(cfg.proxmox)) {
    const v1 = normalizeV1(cfg);
    const deployments = v1.deployments.map((entry) => mergeDeploymentEntry(v1.defaults, entry));
    validateDeployments(deployments);
    return { schemaVersion: 1, defaults: v1.defaults, deployments };
  }
  throw new Error("crowdsec config needs deployments[] or legacy deploy + proxmox blocks");
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!deploymentSystemIdPattern(CROWDSEC_ROLE).test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match crowdsec-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    if (mode === "proxmox-lxc" || mode === "" || !mode) {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
      if (!hostId) {
        throw new Error(`${sid}: proxmox.host_id required for proxmox-lxc`);
      }
      const lxc = isObject(px.lxc) ? px.lxc : {};
      const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
      if (!Number.isFinite(vmid) || vmid <= 0) {
        throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} crowdsec
 */
export function crowdsecLapiPort(crowdsec) {
  const p = typeof crowdsec.lapi_port === "number" ? crowdsec.lapi_port : Number(crowdsec.lapi_port);
  return Number.isFinite(p) && p > 0 && p <= 65535 ? p : 8080;
}

/**
 * Vault key for LAPI auto_registration token (guest agent enroll).
 * @param {Record<string, unknown>} crowdsec
 */
export function crowdsecEnrollKeyVaultKey(crowdsec) {
  const key =
    typeof crowdsec.enroll_key_vault_key === "string" ? crowdsec.enroll_key_vault_key.trim() : "";
  return key || "HDC_CROWDSEC_ENROLL_KEY";
}

/**
 * @typedef {{ type: 'firewall' | 'unifi'; system_id?: string; group_name?: string; max_decisions?: number; enabled?: boolean; never_block_cidrs?: string[] }} CrowdsecBouncerEntry
 */

/**
 * @param {Record<string, unknown>} crowdsec
 * @returns {CrowdsecBouncerEntry[]}
 */
export function crowdsecBouncers(crowdsec) {
  const raw = Array.isArray(crowdsec.bouncers) ? crowdsec.bouncers : [];
  return raw
    .filter((row) => isObject(row))
    .map((row) => {
      const typeRaw = typeof row.type === "string" ? row.type.trim().toLowerCase() : "firewall";
      const type = typeRaw === "unifi" ? "unifi" : "firewall";
      /** @type {CrowdsecBouncerEntry} */
      const entry = { type };
      if (typeof row.system_id === "string" && row.system_id.trim()) {
        entry.system_id = row.system_id.trim();
      }
      if (typeof row.group_name === "string" && row.group_name.trim()) {
        entry.group_name = row.group_name.trim();
      }
      if (typeof row.max_decisions === "number") {
        entry.max_decisions = row.max_decisions;
      }
      if (row.enabled === false || row.enabled === 0) {
        entry.enabled = false;
      }
      if (Array.isArray(row.never_block_cidrs)) {
        entry.never_block_cidrs = row.never_block_cidrs
          .filter((v) => typeof v === "string" && v.trim())
          .map((v) => v.trim());
      }
      return entry;
    })
    .filter((b) => {
      if (b.enabled === false) return false;
      if (b.type === "firewall") return Boolean(b.system_id);
      return true;
    });
}

/**
 * @param {Record<string, unknown>} crowdsec
 */
export function crowdsecFirewallBouncers(crowdsec) {
  return crowdsecBouncers(crowdsec).filter((b) => b.type === "firewall");
}

/**
 * @param {Record<string, unknown>} crowdsec
 */
export function crowdsecUnifiBouncers(crowdsec) {
  return crowdsecBouncers(crowdsec).filter((b) => b.type === "unifi");
}

/**
 * @param {Record<string, unknown>} crowdsec
 */
export function crowdsecCollectionsFromConfig(crowdsec) {
  const raw = Array.isArray(crowdsec.collections) ? crowdsec.collections : [];
  return raw.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listCrowdsecDeploymentSummaries(cfg) {
  const { deployments } = normalizeCrowdsecConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : "proxmox-lxc";
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const install = isObject(d.install) ? d.install : {};
    const crowdsec = isObject(d.crowdsec) ? d.crowdsec : {};
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      install_enabled: install.enabled !== false,
      lapi_port: crowdsecLapiPort(crowdsec),
      bouncer_count: crowdsecBouncers(crowdsec).length,
    };
  });
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (deploymentSystemIdPattern(CROWDSEC_ROLE).test(t)) return t;
  return lxcSystemId(CROWDSEC_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(d, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-lxc";
  return {
    systemId: String(d.system_id),
    mode,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    crowdsec: isObject(d.crowdsec) ? d.crowdsec : {},
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveCrowdsecDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizeCrowdsecConfig(cfg);
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
    return [finalizeDeployment(d, skipInstallCli, opts.skipInstall)];
  }

  if (!selectedId) {
    return deployments.map((d) => finalizeDeployment(d, skipInstallCli, opts.skipInstall));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(d, skipInstallCli, opts.skipInstall)];
}
