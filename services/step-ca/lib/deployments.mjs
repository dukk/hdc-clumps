import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";

const STEP_CA_ROLE = "step-ca";

/** @typedef {"standalone"} StepCaRole */

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
export function normalizeStepCaConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("step-ca config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("step-ca config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const stepCa = isObject(cfg.step_ca)
    ? cfg.step_ca
    : isObject(defaults.step_ca)
      ? defaults.step_ca
      : {};
  return { schemaVersion: version >= 2 ? 2 : version, defaults, deployments, stepCa };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();

  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!/^vm-step-ca-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-step-ca-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);

    const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "";
    if (role !== "standalone") {
      throw new Error(`${sid}: role must be standalone`);
    }

    const mode = typeof d.mode === "string" ? d.mode.trim() : "proxmox-qemu";
    if (mode === "proxmox-qemu" || mode === "configure-only") {
      const px = isObject(d.proxmox) ? d.proxmox : {};
      if (mode === "proxmox-qemu") {
        const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
        if (!hostId) throw new Error(`${sid}: proxmox.host_id required for proxmox-qemu`);
        const q = isObject(px.qemu) ? px.qemu : {};
        const vmid = typeof q.vmid === "number" ? q.vmid : Number(q.vmid);
        if (!Number.isFinite(vmid) || vmid <= 0) {
          throw new Error(`${sid}: proxmox.qemu.vmid must be a positive number`);
        }
      }
      const configure = isObject(d.configure) ? d.configure : {};
      const ssh = isObject(configure.ssh) ? configure.ssh : {};
      const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
      if (!host) {
        throw new Error(`${sid}: configure.ssh.host required`);
      }
    }
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-step-ca-[a-z]+$/.test(t)) return t;
  return vmSystemId(STEP_CA_ROLE, t);
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} skipInstallCli
 */
function finalizeDeployment(d, skipInstallCli) {
  const install = isObject(d.install) ? { ...d.install } : { enabled: true };
  if (skipInstallCli) install.enabled = false;
  const mode = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : "proxmox-qemu";
  const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "standalone";
  return {
    systemId: String(d.system_id),
    mode,
    role: /** @type {StepCaRole} */ (role),
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    install,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveStepCaDeployments(cfg, flags) {
  const { deployments } = normalizeStepCaConfig(cfg);
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
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d, skipInstallCli)];
}

/**
 * @param {ReturnType<typeof normalizeStepCaConfig>} normalized
 */
export function stepCaGlobalSettings(normalized) {
  const sc = isObject(normalized.stepCa) ? normalized.stepCa : {};
  const dnsNames = Array.isArray(sc.dns_names)
    ? sc.dns_names.map((d) => String(d).trim()).filter(Boolean)
    : [];
  if (dnsNames.length === 0) {
    throw new Error("step_ca.dns_names needs at least one DNS name");
  }
  return {
    caName:
      typeof sc.ca_name === "string" && sc.ca_name.trim() ? sc.ca_name.trim() : "HDC Internal CA",
    dnsNames,
    listenAddress:
      typeof sc.listen_address === "string" && sc.listen_address.trim()
        ? sc.listen_address.trim()
        : ":443",
    deploymentType:
      typeof sc.deployment_type === "string" && sc.deployment_type.trim()
        ? sc.deployment_type.trim()
        : "standalone",
    provisionerName:
      typeof sc.provisioner_name === "string" && sc.provisioner_name.trim()
        ? sc.provisioner_name.trim()
        : "admin",
    enableAcme: sc.enable_acme !== false,
    passwordVaultKey:
      typeof sc.password_vault_key === "string" && sc.password_vault_key.trim()
        ? sc.password_vault_key.trim()
        : "HDC_STEP_CA_PASSWORD",
    stepPath:
      typeof sc.step_path === "string" && sc.step_path.trim() ? sc.step_path.trim() : "/etc/step-ca",
  };
}

/**
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function sshHostFromDeployment(deployment) {
  const cfg = deployment.configure;
  if (!isObject(cfg) || !isObject(cfg.ssh)) return "";
  const host = typeof cfg.ssh.host === "string" ? cfg.ssh.host.trim() : "";
  return host;
}
