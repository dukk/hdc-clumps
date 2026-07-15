import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";

const NGINX_ROLE = "nginx";

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
export function normalizeNginxConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("nginx config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("nginx config needs deployments[] with at least one entry");
  }
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  validateDeployments(deployments);
  const sites = Array.isArray(cfg.sites)
    ? cfg.sites.filter(isObject)
    : Array.isArray(defaults.sites)
      ? defaults.sites.filter(isObject)
      : [];
  const letsencrypt = isObject(cfg.letsencrypt)
    ? cfg.letsencrypt
    : isObject(defaults.letsencrypt)
      ? defaults.letsencrypt
      : {};
  const nginx = isObject(cfg.nginx)
    ? cfg.nginx
    : isObject(defaults.nginx)
      ? defaults.nginx
      : {};
  return {
    schemaVersion: version >= 2 ? 2 : version,
    defaults,
    deployments,
    sites,
    letsencrypt,
    nginx,
  };
}

/**
 * @param {Record<string, unknown>[]} deployments
 */
function validateDeployments(deployments) {
  const ids = new Set();
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error("each deployment needs system_id");
    if (!/^vm-nginx-[a-z]+$/.test(sid)) {
      throw new Error(`system_id ${JSON.stringify(sid)} must match vm-nginx-<letter>`);
    }
    if (ids.has(sid)) throw new Error(`duplicate system_id ${JSON.stringify(sid)}`);
    ids.add(sid);
    const mode = typeof d.mode === "string" ? d.mode.trim() : "";
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
    }
  }
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-nginx-[a-z]+$/.test(t)) return t;
  return vmSystemId(NGINX_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveNginxDeployments(cfg, flags) {
  const { deployments } = normalizeNginxConfig(cfg);
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
    return [finalizeDeployment(d)];
  }

  if (!selectedId) {
    return deployments.map((d) => finalizeDeployment(d));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) throw new Error(`unknown system_id ${JSON.stringify(selectedId)}`);
  return [finalizeDeployment(d)];
}

/**
 * @param {Record<string, unknown>} d
 */
function finalizeDeployment(d) {
  const mode = typeof d.mode === "string" ? d.mode.trim() : "configure-only";
  return {
    systemId: String(d.system_id),
    mode,
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    installEnabled: isObject(d.install) ? d.install.enabled !== false : true,
  };
}

/**
 * @param {ReturnType<typeof normalizeNginxConfig>} normalized
 */
export function nginxGlobalSettings(normalized) {
  const le = isObject(normalized.letsencrypt) ? normalized.letsencrypt : {};
  const dns = isObject(le.dns) ? le.dns : {};
  const nw = isObject(normalized.nginx) ? normalized.nginx : {};
  const challenge =
    typeof le.challenge === "string" && le.challenge.trim().toLowerCase() === "dns-01"
      ? "dns-01"
      : "http-01";
  return {
    sites: normalized.sites,
    challenge,
    email: typeof le.email === "string" && le.email.trim() ? le.email.trim() : "",
    emailVaultKey:
      typeof le.email_vault_key === "string" && le.email_vault_key.trim()
        ? le.email_vault_key.trim()
        : "HDC_NGINX_LE_EMAIL",
    staging: le.staging === true,
    webroot:
      typeof le.webroot === "string" && le.webroot.trim()
        ? le.webroot.trim()
        : "/var/www/letsencrypt",
    dnsZone: typeof dns.zone === "string" ? dns.zone.trim() : "",
    dnsNameservers: Array.isArray(dns.nameservers)
      ? dns.nameservers.map((n) => String(n).trim()).filter(Boolean)
      : [],
    dnsTsigVaultKey:
      typeof dns.tsig_vault_key === "string" && dns.tsig_vault_key.trim()
        ? dns.tsig_vault_key.trim()
        : "HDC_BIND_TSIG_KEY",
    dnsKeyName:
      typeof dns.key_name === "string" && dns.key_name.trim()
        ? dns.key_name.trim()
        : "hdc-bind-xfer",
    clientMaxBodySize:
      typeof nw.client_max_body_size === "string" && nw.client_max_body_size.trim()
        ? nw.client_max_body_size.trim()
        : "64m",
    proxyReadTimeout:
      typeof nw.proxy_read_timeout === "string" && nw.proxy_read_timeout.trim()
        ? nw.proxy_read_timeout.trim()
        : "300s",
    proxyConnectTimeout:
      typeof nw.proxy_connect_timeout === "string" && nw.proxy_connect_timeout.trim()
        ? nw.proxy_connect_timeout.trim()
        : "60s",
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} [siteIdFilter]
 */
export function resolveSites(cfg, siteIdFilter) {
  const { sites } = normalizeNginxConfig(cfg);
  if (!siteIdFilter) return sites;
  const id = siteIdFilter.trim();
  const filtered = sites.filter((s) => typeof s.id === "string" && s.id.trim() === id);
  if (!filtered.length) throw new Error(`unknown site id ${JSON.stringify(id)}`);
  return filtered;
}

/**
 * SSH target from deployment configure block.
 * @param {ReturnType<typeof finalizeDeployment>} deployment
 */
export function sshTargetFromDeployment(deployment) {
  const cfg = deployment.configure;
  const ssh = isObject(cfg) && isObject(cfg.ssh) ? cfg.ssh : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host) throw new Error(`${deployment.systemId}: configure.ssh.host required`);
  return { user, host };
}
