import {
  deploymentSystemIdPattern,
  lxcSystemId,
  vmSystemId,
} from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { normalizeModelNames } from "./ollama-models.mjs";

const OLLAMA_ROLE = "ollama";
const OLLAMA_LXC_SYSTEM_ID = deploymentSystemIdPattern(OLLAMA_ROLE);
const OLLAMA_QEMU_SYSTEM_ID = /^vm-ollama-[a-z]+$/;

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
      : lxcSystemId(OLLAMA_ROLE, "a");
  /** @type {Record<string, unknown>} */
  const defaults = { mode };
  if (isObject(cfg.proxmox)) defaults.proxmox = structuredClone(cfg.proxmox);
  if (isObject(cfg.ubuntu)) defaults.ubuntu = structuredClone(cfg.ubuntu);
  if (isObject(cfg.install)) defaults.install = structuredClone(cfg.install);
  if (isObject(cfg.ollama)) defaults.ollama = structuredClone(cfg.ollama);
  return {
    schemaVersion: 1,
    defaults,
    deployments: [{ system_id: systemId }],
  };
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeOllamaConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("ollama config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (Array.isArray(cfg.deployments) && cfg.deployments.length > 0) {
    const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
    const raw = cfg.deployments.filter(isObject);
    if (!raw.length) {
      throw new Error("deployments[] is empty — add at least one entry");
    }
    const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
    validateDeployments(deployments);
    return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments };
  }
  if (isObject(cfg.deploy) || isObject(cfg.proxmox)) {
    const v1 = normalizeV1(cfg);
    const deployments = v1.deployments.map((entry) =>
      mergeDeploymentEntry(v1.defaults, entry),
    );
    validateDeployments(deployments);
    return { schemaVersion: 1, defaults: v1.defaults, deployments };
  }
  throw new Error("ollama config needs deployments[] or legacy deploy + proxmox blocks");
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
    if (mode === "proxmox-qemu") {
      if (!OLLAMA_QEMU_SYSTEM_ID.test(sid)) {
        throw new Error(`system_id ${JSON.stringify(sid)} must match vm-ollama-<letter> for proxmox-qemu`);
      }
    } else if (!OLLAMA_LXC_SYSTEM_ID.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match ollama-<letter> for LXC`);
    }
    if (/^ct-/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must not use legacy ct- prefix`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    if (mode === "proxmox-lxc" || mode === "proxmox-qemu") {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
      if (!hostId) {
        throw new Error(`${sid}: proxmox.host_id required for ${mode}`);
      }
      if (mode === "proxmox-lxc") {
        const lxc = isObject(px.lxc) ? px.lxc : {};
        const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
        if (!Number.isFinite(vmid) || vmid <= 0) {
          throw new Error(`${sid}: proxmox.lxc.vmid must be a positive number`);
        }
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function listOllamaDeploymentSummaries(cfg) {
  const { deployments } = normalizeOllamaConfig(cfg);
  return deployments.map((d) => {
    const mode = typeof d.mode === "string" ? d.mode : null;
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const hostId = typeof px.host_id === "string" ? px.host_id : null;
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    const install = isObject(d.install) ? d.install : {};
    const models = normalizeModelNames(d.ollama);
    return {
      system_id: d.system_id,
      mode,
      host_id: hostId,
      vmid: Number.isFinite(vmid) ? vmid : null,
      install_enabled: install.enabled !== false,
      install_method:
        typeof install.method === "string" ? install.method : "github-release",
      configured_models: models,
      model_count: models.length,
    };
  });
}

/**
 * Resolve instance flag to a system id (`a` → `ollama-a`, or pass full `ollama-a` / `vm-ollama-a`).
 * @param {string | undefined} instance
 * @param {Record<string, unknown>[] | undefined} [deployments]
 */
export function instanceFlagToSystemId(instance, deployments) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (OLLAMA_LXC_SYSTEM_ID.test(t) || OLLAMA_QEMU_SYSTEM_ID.test(t)) return t;
  if (Array.isArray(deployments) && deployments.length > 0) {
    const letter = t.length === 1 || /^[a-z]+$/.test(t) ? t : null;
    if (letter) {
      const qemu = deployments.find(
        (d) =>
          typeof d.system_id === "string" &&
          OLLAMA_QEMU_SYSTEM_ID.test(d.system_id) &&
          d.system_id.endsWith(`-${letter}`),
      );
      if (qemu && typeof qemu.system_id === "string") return qemu.system_id;
      const lxc = deployments.find(
        (d) =>
          typeof d.system_id === "string" &&
          OLLAMA_LXC_SYSTEM_ID.test(d.system_id) &&
          d.system_id.endsWith(`-${letter}`),
      );
      if (lxc && typeof lxc.system_id === "string") return lxc.system_id;
    }
  }
  if (OLLAMA_QEMU_SYSTEM_ID.test(vmSystemId(OLLAMA_ROLE, t))) {
    return vmSystemId(OLLAMA_ROLE, t);
  }
  return lxcSystemId(OLLAMA_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 * @returns {ReturnType<typeof finalizeDeployment>[]}
 */
export function resolveOllamaDeployments(cfg, flags, opts = {}) {
  const { deployments } = normalizeOllamaConfig(cfg);
  const skipInstallCli = flags["skip-install"] !== undefined;

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance, deployments);
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

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 * @param {{ skipInstall?: boolean }} [opts]
 */
export function resolveOllamaDeployment(cfg, flags, opts = {}) {
  const list = resolveOllamaDeployments(cfg, flags, opts);
  return list[0];
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 * @param {boolean | undefined} skipInstallOpt
 */
function finalizeDeployment(d, skipInstallCli, skipInstallOpt) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true, method: "github-release" };
  if (skipInstallCli || skipInstallOpt === true) {
    install.enabled = false;
  }
  const mode = typeof d.mode === "string" ? d.mode.trim() : "";
  const hostname =
    typeof d.hostname === "string" && d.hostname.trim() ? d.hostname.trim() : undefined;
  const models = normalizeModelNames(d.ollama);
  return {
    systemId: String(d.system_id),
    mode,
    hostname,
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    ubuntu: isObject(d.ubuntu) ? d.ubuntu : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
    ollama: { models },
    raw: d,
  };
}
