import { flagGet } from "hdc/package/parse-argv-flags.mjs";

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
export function normalizeSynologyConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("synology-nas config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("synology-nas config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  return { schemaVersion: version, defaults, deployments };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  const instances = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!/^nas-[a-z0-9][a-z0-9-]*$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} should match nas-<slug> (physical NAS)`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const inst = typeof d.instance === "string" ? d.instance.trim() : "";
    if (inst) {
      if (!/^[a-z]$/.test(inst)) {
        throw new Error(`${sid}: instance must be a single letter (a-z)`);
      }
      if (instances.has(inst)) throw new Error(`duplicate instance letter ${JSON.stringify(inst)}`);
      instances.add(inst);
    }

    const ssh = isObject(d.ssh) ? d.ssh : {};
    const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
    if (!host) throw new Error(`${sid}: ssh.host required`);
  }
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(deployments, instance) {
  if (!instance) return undefined;
  const t = instance.trim().toLowerCase();
  if (/^nas-[a-z0-9][a-z0-9-]*$/.test(t)) return t;
  const byLetter = deployments.find(
    (d) => typeof d.instance === "string" && d.instance.trim().toLowerCase() === t,
  );
  if (byLetter && typeof byLetter.system_id === "string") return byLetter.system_id.trim();
  return undefined;
}

/**
 * @param {Record<string, unknown>} d
 */
function finalizeDeployment(d) {
  const sshBlock = isObject(d.ssh) ? d.ssh : {};
  const user =
    typeof sshBlock.user === "string" && sshBlock.user.trim() ? sshBlock.user.trim() : "admin";
  const host = typeof sshBlock.host === "string" ? sshBlock.host.trim() : "";
  const instance = typeof d.instance === "string" ? d.instance.trim().toLowerCase() : "";
  const maintainEntry = isObject(d.maintain) ? d.maintain : {};
  const sk = maintainEntry.ssh_keys;
  const dockerEntry = isObject(d.docker) ? d.docker : {};
  const composeBase =
    typeof dockerEntry.compose_base_dir === "string" && dockerEntry.compose_base_dir.trim()
      ? dockerEntry.compose_base_dir.trim()
      : "/volume1/docker";
  return {
    systemId: String(d.system_id),
    instance,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    ssh: { user, host },
    maintain: {
      rebootWaitSeconds:
        typeof maintainEntry.reboot_wait_seconds === "number"
          ? maintainEntry.reboot_wait_seconds
          : 600,
      dsmUpgrade: maintainEntry.dsm_upgrade !== false && maintainEntry.dsm_upgrade !== 0,
      packageUpgrade: maintainEntry.package_upgrade !== false && maintainEntry.package_upgrade !== 0,
      sshKeysEnabled: !isObject(sk) || (sk.enabled !== false && sk.enabled !== 0),
      dockerEnsure:
        maintainEntry.docker_ensure !== false && maintainEntry.docker_ensure !== 0,
    },
    docker: {
      composeBaseDir: composeBase,
    },
    userEnv:
      typeof sshBlock.user_env === "string" && sshBlock.user_env.trim()
        ? sshBlock.user_env.trim()
        : "HDC_SYNOLOGY_SSH_USER",
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveSynologyDeployments(cfg, flags) {
  const { deployments } = normalizeSynologyConfig(cfg);

  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(deployments, instance);
    if (!selectedId) {
      throw new Error(`unknown instance ${JSON.stringify(instance)} (use a|b or nas-a|nas-b)`);
    }
  }

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(d)];
  }

  if (!selectedId) {
    return deployments.map((d) => finalizeDeployment(d));
  }

  const match = deployments.find((d) => d.system_id === selectedId);
  if (!match) {
    throw new Error(
      `unknown system_id ${JSON.stringify(selectedId)} (configured: ${deployments.map((x) => x.system_id).join(", ")})`,
    );
  }
  return [finalizeDeployment(match)];
}

/**
 * @param {ReturnType<typeof normalizeSynologyConfig>} normalized
 */
export function synologyGlobalSettings(normalized) {
  const defaults = normalized.defaults;
  const ssh = isObject(defaults.ssh) ? defaults.ssh : {};
  const maintain = isObject(defaults.maintain) ? defaults.maintain : {};
  const docker = isObject(defaults.docker) ? defaults.docker : {};
  return {
    defaultSshUser: typeof ssh.user === "string" && ssh.user.trim() ? ssh.user.trim() : "admin",
    sshUserEnv:
      typeof ssh.user_env === "string" && ssh.user_env.trim()
        ? ssh.user_env.trim()
        : "HDC_SYNOLOGY_SSH_USER",
    maintain: {
      rebootWaitSeconds:
        typeof maintain.reboot_wait_seconds === "number" ? maintain.reboot_wait_seconds : 600,
      dsmUpgrade: maintain.dsm_upgrade !== false && maintain.dsm_upgrade !== 0,
      packageUpgrade: maintain.package_upgrade !== false && maintain.package_upgrade !== 0,
      sshKeysEnabled: (() => {
        const sk = maintain.ssh_keys;
        if (!isObject(sk)) return true;
        return sk.enabled !== false && sk.enabled !== 0;
      })(),
      dockerEnsure: maintain.docker_ensure !== false && maintain.docker_ensure !== 0,
    },
    docker: {
      composeBaseDir:
        typeof docker.compose_base_dir === "string" && docker.compose_base_dir.trim()
          ? docker.compose_base_dir.trim()
          : "/volume1/docker",
    },
  };
}
