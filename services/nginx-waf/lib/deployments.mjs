import { readFileSync } from "node:fs";
import { stderr as errout } from "node:process";

import { vmSystemId } from "hdc/cli/lib/inventory-naming.mjs";
import { resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { hostNames, migrateSiteHostNames } from "./nginx-waf-render.mjs";
import {
  collectGroupPolicyPlan,
  mergePolicyDefinitions,
  migrateSitePoliciesV4,
} from "./nginx-waf-policies.mjs";

const NGINX_WAF_ROLE = "nginx-waf";

/** @deprecated Use HDC_NGINX_WAF_LETS_ENCRYPT_EMAIL */
export const LEGACY_LETS_ENCRYPT_EMAIL_VAULT_KEY = "HDC_NGINX_WAF_LE_EMAIL";
export const DEFAULT_LETS_ENCRYPT_EMAIL_VAULT_KEY = "HDC_NGINX_WAF_LETS_ENCRYPT_EMAIL";

/** Default trusted networks for internal_only location access. */
export const DEFAULT_TRUSTED_CIDRS = [
  "192.0.2.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
];

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
 * @param {unknown} raw
 */
function normalizeGroupId(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`deployment group id ${JSON.stringify(raw)} must be a lowercase slug`);
  }
  return id;
}

/**
 * @param {Record<string, unknown> | undefined} letsencrypt
 */
function migrateLetsencryptToAcme(letsencrypt) {
  const le = isObject(letsencrypt) ? letsencrypt : {};
  const emailVaultKey =
    typeof le.email_vault_key === "string" && le.email_vault_key.trim()
      ? le.email_vault_key.trim()
      : DEFAULT_LETS_ENCRYPT_EMAIL_VAULT_KEY;
  return {
    provider: "lets_encrypt",
    ...le,
    email_vault_key: emailVaultKey,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>} defaults
 */
function buildDeploymentGroups(cfg, defaults) {
  if (Array.isArray(cfg.deployment_groups) && cfg.deployment_groups.length > 0) {
    return cfg.deployment_groups.filter(isObject).map((raw) => {
      const id = normalizeGroupId(raw.id);
      const acmeRaw = isObject(raw.acme)
        ? raw.acme
        : isObject(raw.letsencrypt)
          ? migrateLetsencryptToAcme(raw.letsencrypt)
          : migrateLetsencryptToAcme(
              isObject(cfg.letsencrypt) ? cfg.letsencrypt : defaults.letsencrypt,
            );
      const sitesRaw = Array.isArray(raw.sites)
        ? raw.sites.filter(isObject).map((s) => migrateSiteHostNames(s))
        : [];
      const policyDefinitions = mergePolicyDefinitions(defaults, raw);
      const nw = isObject(defaults.nginx_waf) ? defaults.nginx_waf : {};
      const trustedFallback = Array.isArray(nw.trusted_cidrs) && nw.trusted_cidrs.length
        ? nw.trusted_cidrs.map((c) => String(c).trim()).filter(Boolean)
        : DEFAULT_TRUSTED_CIDRS;
      const sites = sitesRaw.map((s) => migrateSitePoliciesV4(s, trustedFallback));
      const rawDeployments = Array.isArray(raw.deployments) ? raw.deployments.filter(isObject) : [];
      if (!rawDeployments.length) {
        throw new Error(`deployment group ${JSON.stringify(id)} needs deployments[]`);
      }
      const deployments = rawDeployments.map((entry) => mergeDeploymentEntry(defaults, entry));
      const defaultSiteRaw = isObject(raw.default_site) ? raw.default_site : {};
      return {
        id,
        acme: acmeRaw,
        sites,
        deployments,
        defaultSite: { enabled: defaultSiteRaw.enabled !== false },
        policyDefinitions,
      };
    });
  }

  if (!Array.isArray(cfg.deployments) || cfg.deployments.length === 0) {
    throw new Error("nginx-waf config needs deployment_groups[] or deployments[]");
  }

  const raw = cfg.deployments.filter(isObject);
  const deployments = raw.map((entry) => mergeDeploymentEntry(defaults, entry));
  const sitesRaw = Array.isArray(cfg.sites)
    ? cfg.sites.filter(isObject).map((s) => migrateSiteHostNames(s))
    : Array.isArray(defaults.sites)
      ? defaults.sites.filter(isObject).map((s) => migrateSiteHostNames(s))
      : [];
  const policyDefinitions = mergePolicyDefinitions(defaults, null);
  const nw = isObject(defaults.nginx_waf) ? defaults.nginx_waf : {};
  const trustedFallback = Array.isArray(nw.trusted_cidrs) && nw.trusted_cidrs.length
    ? nw.trusted_cidrs.map((c) => String(c).trim()).filter(Boolean)
    : DEFAULT_TRUSTED_CIDRS;
  const sites = sitesRaw.map((s) => migrateSitePoliciesV4(s, trustedFallback));
  const letsencrypt = isObject(cfg.letsencrypt)
    ? cfg.letsencrypt
    : isObject(defaults.letsencrypt)
      ? defaults.letsencrypt
      : {};

  return [
    {
      id: "default",
      acme: migrateLetsencryptToAcme(letsencrypt),
      sites,
      deployments,
      defaultSite: { enabled: true },
      policyDefinitions,
    },
  ];
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function normalizeNginxWafConfig(cfg) {
  if (!isObject(cfg)) {
    throw new Error("nginx-waf config must be a JSON object");
  }
  const version = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  const defaults = isObject(cfg.defaults) ? structuredClone(cfg.defaults) : {};
  const deploymentGroups = buildDeploymentGroups(cfg, defaults);

  const allSystemIds = new Set();
  for (const group of deploymentGroups) {
    validateDeployments(group.deployments, group.id);
    validateSites(group.sites, group.id);
    for (const d of group.deployments) {
      const sid = String(d.system_id);
      if (allSystemIds.has(sid)) {
        throw new Error(`duplicate system_id ${JSON.stringify(sid)} across deployment groups`);
      }
      allSystemIds.add(sid);
    }
  }

  const nginxWaf = isObject(cfg.nginx_waf)
    ? cfg.nginx_waf
    : isObject(defaults.nginx_waf)
      ? defaults.nginx_waf
      : {};

  const firstGroup = deploymentGroups[0];
  return {
    schemaVersion: version >= 4 ? 4 : version >= 3 ? 3 : version >= 2 ? 2 : version,
    defaults,
    deploymentGroups,
    nginxWaf,
    // Legacy flat fields from first/default group for callers not yet group-aware
    deployments: firstGroup.deployments,
    sites: firstGroup.sites,
    letsencrypt: firstGroup.acme,
  };
}

/**
 * @param {Record<string, unknown>[]} sites
 * @param {string} groupId
 */
function validateSites(sites, groupId) {
  /** @type {Map<string, string>} */
  const hostnameOwner = new Map();
  for (const site of sites) {
    const id = typeof site.id === "string" ? site.id.trim() : "";
    if (!id) throw new Error(`deployment group ${groupId}: site needs id`);
    for (const name of hostNames(site)) {
      const prev = hostnameOwner.get(name);
      if (prev && prev !== id) {
        throw new Error(
          `deployment group ${groupId}: host_name ${JSON.stringify(name)} is listed on sites ${JSON.stringify(prev)} and ${JSON.stringify(id)}`,
        );
      }
      hostnameOwner.set(name, id);
    }
  }
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {string} groupId
 */
function validateDeployments(deployments, groupId) {
  const ids = new Set();
  let certPrimaryCount = 0;
  for (const d of deployments) {
    const sid = typeof d.system_id === "string" ? d.system_id.trim() : "";
    if (!sid) throw new Error(`deployment group ${groupId}: each deployment needs system_id`);
    if (!/^vm-nginx-waf-[a-z]+$/.test(sid)) {
      throw new Error(
        `deployment group ${groupId}: system_id ${JSON.stringify(sid)} must match vm-nginx-waf-<letter>`,
      );
    }
    if (ids.has(sid)) {
      throw new Error(`deployment group ${groupId}: duplicate system_id ${JSON.stringify(sid)}`);
    }
    ids.add(sid);
    const role = typeof d.role === "string" ? d.role.trim().toLowerCase() : "";
    if (role !== "cert-primary" && role !== "peer") {
      throw new Error(`${sid}: role must be cert-primary or peer`);
    }
    if (role === "cert-primary") certPrimaryCount += 1;
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
  if (certPrimaryCount !== 1) {
    throw new Error(
      `deployment group ${groupId}: must include exactly one cert-primary (found ${certPrimaryCount})`,
    );
  }
}

/**
 * @param {ReturnType<typeof normalizeNginxWafConfig>} normalized
 * @param {string} [groupId]
 */
export function findDeploymentGroup(normalized, groupId) {
  if (groupId) {
    const group = normalized.deploymentGroups.find((g) => g.id === groupId);
    if (!group) throw new Error(`unknown deployment group ${JSON.stringify(groupId)}`);
    return group;
  }
  return normalized.deploymentGroups[0];
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveNginxWafGroups(cfg, flags) {
  const normalized = normalizeNginxWafConfig(cfg);
  const groupFilter = flagGet(flags, "group");
  let groups = normalized.deploymentGroups;
  if (groupFilter) {
    const id = groupFilter.trim();
    groups = groups.filter((g) => g.id === id);
    if (!groups.length) {
      throw new Error(
        `unknown deployment group ${JSON.stringify(id)} (configured: ${normalized.deploymentGroups.map((g) => g.id).join(", ")})`,
      );
    }
  }
  return groups.map((group) => ({
    groupId: group.id,
    acme: group.acme,
    defaultSite: group.defaultSite,
    sites: group.sites,
    deployments: selectDeploymentsInGroup(group.deployments, flags, group.id),
    global: nginxWafGroupSettings(normalized, group),
  }));
}

/**
 * @param {Record<string, unknown>[]} deployments
 * @param {Record<string, string>} flags
 * @param {string} groupId
 */
function selectDeploymentsInGroup(deployments, flags, groupId) {
  let selectedId = flagGet(flags, "system-id", "system_id");
  const instance = flagGet(flags, "instance");
  if (!selectedId && instance) {
    selectedId = instanceFlagToSystemId(instance);
  }

  if (deployments.length === 1) {
    const d = deployments[0];
    if (selectedId && selectedId !== d.system_id) {
      throw new Error(
        `deployment group ${groupId}: unknown system_id ${JSON.stringify(selectedId)} (only ${JSON.stringify(d.system_id)} configured)`,
      );
    }
    return [finalizeDeployment(d, groupId)];
  }

  if (!selectedId) {
    const sorted = [...deployments].sort((a, b) => {
      const ra = typeof a.role === "string" && a.role === "cert-primary" ? 0 : 1;
      const rb = typeof b.role === "string" && b.role === "cert-primary" ? 0 : 1;
      return ra - rb;
    });
    return sorted.map((d) => finalizeDeployment(d, groupId));
  }

  const d = deployments.find((x) => x.system_id === selectedId);
  if (!d) {
    throw new Error(`deployment group ${groupId}: unknown system_id ${JSON.stringify(selectedId)}`);
  }
  return [finalizeDeployment(d, groupId)];
}

/**
 * Full sites[] for vhost push; certSites scopes certificate obtain/renew/status when --site is set.
 * @param {ReturnType<typeof nginxWafGroupSettings>} global
 * @param {Record<string, unknown>} cfg
 * @param {string | undefined} siteFilter
 * @param {string} [groupId]
 */
export function maintainSiteLists(global, cfg, siteFilter, groupId) {
  const allSites = /** @type {Record<string, unknown>[]} */ (global.sites);
  const partialSiteUpdate = Boolean(siteFilter);
  const certSites = partialSiteUpdate
    ? resolveSites(cfg, String(siteFilter).trim(), groupId)
    : allSites;
  return { allSites, certSites, partialSiteUpdate };
}

/**
 * @param {string | undefined} instance
 */
export function instanceFlagToSystemId(instance) {
  if (!instance) return undefined;
  const t = instance.trim();
  if (/^vm-nginx-waf-[a-z]+$/.test(t)) return t;
  return vmSystemId(NGINX_WAF_ROLE, t);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveNginxWafDeployments(cfg, flags) {
  const contexts = resolveNginxWafGroups(cfg, flags);
  /** @type {ReturnType<typeof finalizeDeployment>[]} */
  const out = [];
  for (const ctx of contexts) {
    out.push(...ctx.deployments);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} d
 * @param {string} groupId
 */
function finalizeDeployment(d, groupId) {
  const mode = typeof d.mode === "string" ? d.mode.trim() : "configure-only";
  const roleRaw = typeof d.role === "string" ? d.role.trim().toLowerCase() : "peer";
  const role = roleRaw === "cert-primary" ? "cert-primary" : "peer";
  return {
    systemId: String(d.system_id),
    groupId,
    mode,
    role: /** @type {"cert-primary" | "peer"} */ (role),
    hostname: typeof d.hostname === "string" ? d.hostname.trim() : "",
    proxmox: isObject(d.proxmox) ? d.proxmox : null,
    configure: isObject(d.configure) ? d.configure : null,
    installEnabled: isObject(d.install) ? d.install.enabled !== false : true,
  };
}

/**
 * @param {Record<string, unknown>} acme
 */
export function parseAcmeSettings(acme) {
  const raw = isObject(acme) ? acme : {};
  const providerRaw =
    typeof raw.provider === "string" ? raw.provider.trim().toLowerCase() : "lets_encrypt";
  const provider =
    providerRaw === "custom" || providerRaw === "step_ca" || providerRaw === "step-ca"
      ? "custom"
      : "lets_encrypt";
  const dns = isObject(raw.dns) ? raw.dns : {};
  const challenge =
    typeof raw.challenge === "string" && raw.challenge.trim().toLowerCase() === "dns-01"
      ? "dns-01"
      : "http-01";
  return {
    provider,
    challenge,
    email: typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : "",
    emailVaultKey:
      typeof raw.email_vault_key === "string" && raw.email_vault_key.trim()
        ? raw.email_vault_key.trim()
        : DEFAULT_LETS_ENCRYPT_EMAIL_VAULT_KEY,
    staging: raw.staging === true,
    certPrimarySystemId:
      typeof raw.cert_primary_system_id === "string" && raw.cert_primary_system_id.trim()
        ? raw.cert_primary_system_id.trim()
        : "",
    server:
      typeof raw.server === "string" && raw.server.trim() ? raw.server.trim() : "",
    rootCaPath:
      typeof raw.root_ca_path === "string" && raw.root_ca_path.trim()
        ? raw.root_ca_path.trim()
        : "/etc/ssl/certs/hdc-step-ca-root.crt",
    rootCaFile:
      typeof raw.root_ca_file === "string" && raw.root_ca_file.trim()
        ? raw.root_ca_file.trim()
        : "",
    webroot:
      typeof raw.webroot === "string" && raw.webroot.trim()
        ? raw.webroot.trim()
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
  };
}

/**
 * Rebuild raw ACME config shape from parseAcmeSettings output (for re-parsing after merge).
 * @param {ReturnType<typeof parseAcmeSettings>} parsed
 * @returns {Record<string, unknown>}
 */
export function acmeParsedToRaw(parsed) {
  if (!parsed || typeof parsed !== "object") return {};
  /** @type {Record<string, unknown>} */
  const raw = {
    provider: parsed.provider === "custom" ? "custom" : "lets_encrypt",
    challenge: parsed.challenge,
    staging: parsed.staging,
  };
  if (parsed.email) raw.email = parsed.email;
  if (parsed.emailVaultKey) raw.email_vault_key = parsed.emailVaultKey;
  if (parsed.certPrimarySystemId) raw.cert_primary_system_id = parsed.certPrimarySystemId;
  if (parsed.server) raw.server = parsed.server;
  if (parsed.rootCaPath) raw.root_ca_path = parsed.rootCaPath;
  if (parsed.rootCaFile) raw.root_ca_file = parsed.rootCaFile;
  if (parsed.webroot) raw.webroot = parsed.webroot;
  if (parsed.dnsZone || (parsed.dnsNameservers && parsed.dnsNameservers.length)) {
    raw.dns = {
      zone: parsed.dnsZone,
      nameservers: parsed.dnsNameservers,
      tsig_vault_key: parsed.dnsTsigVaultKey,
      key_name: parsed.dnsKeyName,
    };
  }
  return raw;
}

/**
 * Resolve effective ACME settings for a certificate domain from site tls + group defaults.
 * @param {Record<string, unknown>} site
 * @param {ReturnType<typeof parseAcmeSettings>} groupAcme
 */
export function resolveSiteAcmeSettings(site, groupAcme) {
  const tls = isObject(site.tls) ? site.tls : {};
  const cert = isObject(tls.certificate) ? tls.certificate : {};
  const certDns = isObject(cert.dns) ? cert.dns : null;
  const merged = {
    ...acmeParsedToRaw(groupAcme),
    ...(typeof cert.provider === "string" ? { provider: cert.provider } : {}),
    ...(typeof cert.server === "string" ? { server: cert.server } : {}),
    ...(typeof cert.challenge === "string" ? { challenge: cert.challenge } : {}),
    ...(cert.staging === true || cert.staging === false ? { staging: cert.staging } : {}),
    ...(typeof cert.root_ca_path === "string" ? { root_ca_path: cert.root_ca_path } : {}),
  };
  if (certDns) {
    const groupRaw = acmeParsedToRaw(groupAcme);
    const groupDns = isObject(groupRaw.dns) ? groupRaw.dns : {};
    merged.dns = {
      ...groupDns,
      ...(typeof certDns.zone === "string" ? { zone: certDns.zone } : {}),
      ...(Array.isArray(certDns.nameservers) ? { nameservers: certDns.nameservers } : {}),
      ...(typeof certDns.tsig_vault_key === "string"
        ? { tsig_vault_key: certDns.tsig_vault_key }
        : {}),
      ...(typeof certDns.key_name === "string" ? { key_name: certDns.key_name } : {}),
    };
  }
  return parseAcmeSettings(merged);
}

/**
 * @param {ReturnType<typeof normalizeNginxWafConfig>} normalized
 * @param {{ id: string, acme: Record<string, unknown>, sites: Record<string, unknown>[], defaultSite: { enabled: boolean } }} group
 */
export function nginxWafGroupSettings(normalized, group) {
  const acme = parseAcmeSettings(group.acme);
  const nw = isObject(normalized.nginxWaf) ? normalized.nginxWaf : {};
  const ms = isObject(nw.modsecurity) ? nw.modsecurity : {};
  const certPrimarySystemId =
    acme.certPrimarySystemId ||
    (() => {
      const primary = group.deployments.find(
        (d) => typeof d.role === "string" && d.role.trim().toLowerCase() === "cert-primary",
      );
      return primary && typeof primary.system_id === "string" ? primary.system_id.trim() : "vm-nginx-waf-a";
    })();

  return {
    groupId: group.id,
    sites: group.sites,
    defaultSiteEnabled: group.defaultSite.enabled,
    policyDefinitions: group.policyDefinitions,
    groupPolicyPlan: collectGroupPolicyPlan(group.sites, group.policyDefinitions),
    acme,
    challenge: acme.challenge,
    email: acme.email,
    emailVaultKey: acme.emailVaultKey,
    staging: acme.staging,
    certPrimarySystemId,
    acmeProvider: acme.provider,
    acmeServer: acme.server,
    rootCaPath: acme.rootCaPath,
    rootCaFile: acme.rootCaFile,
    webroot: acme.webroot,
    dnsZone: acme.dnsZone,
    dnsNameservers: acme.dnsNameservers,
    dnsTsigVaultKey: acme.dnsTsigVaultKey,
    dnsKeyName: acme.dnsKeyName,
    modsecurityEnabled:
      ms.enabled !== false &&
      collectGroupPolicyPlan(group.sites, group.policyDefinitions).usesModsecurity,
    modsecurityRuleEngine: (() => {
      const explicit =
        typeof ms.rule_engine === "string" && ms.rule_engine.trim()
          ? ms.rule_engine.trim()
          : "";
      if (explicit === "On" || explicit === "DetectionOnly" || explicit === "Off") {
        return explicit;
      }
      return acme.staging === true ? "DetectionOnly" : "On";
    })(),
    modsecurityCrsSetup:
      typeof ms.crs_setup === "string" && ms.crs_setup.trim()
        ? ms.crs_setup.trim()
        : "/etc/modsecurity/crs/crs-setup.conf",
    modsecurityCrsRulesGlob:
      typeof ms.crs_rules_glob === "string" && ms.crs_rules_glob.trim()
        ? ms.crs_rules_glob.trim()
        : "/usr/share/modsecurity-crs/rules/*.conf",
    modsecurityUnicodeMap:
      typeof ms.unicode_map === "string" && ms.unicode_map.trim() ? ms.unicode_map.trim() : "",
    modsecurityAuditLog:
      typeof ms.audit_log === "string" && ms.audit_log.trim()
        ? ms.audit_log.trim()
        : "/var/log/nginx/modsec_audit.log",
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
    trustedCidrs: parseTrustedCidrs(nw.trusted_cidrs, DEFAULT_TRUSTED_CIDRS),
    cloudflareIpv4: nw.cloudflare_ipv4 !== false,
    defaultClientIp: (() => {
      const raw =
        typeof nw.client_ip === "string" ? nw.client_ip.trim().toLowerCase() : "remote_addr";
      return raw === "cloudflare" ? "cloudflare" : "remote_addr";
    })(),
  };
}

/**
 * @param {ReturnType<typeof normalizeNginxWafConfig>} normalized
 * @param {string} [groupId]
 */
export function nginxWafGlobalSettings(normalized, groupId) {
  const group = findDeploymentGroup(normalized, groupId);
  return nginxWafGroupSettings(normalized, group);
}

/**
 * Load Let's Encrypt email from vault with legacy key fallback.
 * @param {ReturnType<typeof nginxWafGroupSettings>} global
 * @param {{ getSecret: (key: string, opts?: object) => Promise<string> }} vault
 */
export async function loadLetsEncryptEmail(global, vault) {
  if (global.email) return global.email;
  let email = String(
    await vault.getSecret(global.emailVaultKey, {
      promptLabel: `vault secret ${global.emailVaultKey}`,
    }),
  ).trim();
  if (
    !email &&
    global.emailVaultKey === DEFAULT_LETS_ENCRYPT_EMAIL_VAULT_KEY
  ) {
    try {
      email = String(
        await vault.getSecret(LEGACY_LETS_ENCRYPT_EMAIL_VAULT_KEY, {
          promptLabel: `vault secret ${LEGACY_LETS_ENCRYPT_EMAIL_VAULT_KEY}`,
        }),
      ).trim();
      if (email) {
        errout.write(
          `[hdc] nginx-waf: ${LEGACY_LETS_ENCRYPT_EMAIL_VAULT_KEY} is deprecated — run: hdc secrets set ${DEFAULT_LETS_ENCRYPT_EMAIL_VAULT_KEY}\n`,
        );
      }
    } catch {
      // legacy key absent
    }
  }
  return email;
}

/**
 * @param {unknown} raw
 * @param {string[]} fallback
 */
function parseTrustedCidrs(raw, fallback) {
  if (!Array.isArray(raw) || raw.length === 0) return [...fallback];
  return raw.map((c) => String(c).trim()).filter(Boolean);
}

/**
 * Per-site trusted CIDRs and client IP mode for geo / real_ip rendering.
 * @param {Record<string, unknown>} site
 * @param {ReturnType<typeof nginxWafGroupSettings>} global
 */
export function resolveSiteAccessSettings(site, global) {
  const siteCidrs = parseTrustedCidrs(site.trusted_cidrs, []);
  const trustedCidrs = siteCidrs.length > 0 ? siteCidrs : global.trustedCidrs;
  const clientIpRaw =
    typeof site.client_ip === "string"
      ? site.client_ip.trim().toLowerCase()
      : global.defaultClientIp;
  const clientIp = clientIpRaw === "cloudflare" ? "cloudflare" : "remote_addr";
  return {
    trustedCidrs,
    clientIp,
    cloudflareIpv4: global.cloudflareIpv4,
  };
}

/**
 * @param {ReturnType<typeof resolveNginxWafDeployments>} deployments
 * @param {string} certPrimarySystemId
 */
export function findCertPrimaryDeployment(deployments, certPrimarySystemId) {
  const byId = deployments.find((d) => d.systemId === certPrimarySystemId);
  if (byId) return byId;
  const byRole = deployments.find((d) => d.role === "cert-primary");
  if (byRole) return byRole;
  throw new Error(`no cert-primary deployment (expected ${certPrimarySystemId})`);
}

/**
 * @param {ReturnType<typeof resolveNginxWafDeployments>} deployments
 * @param {ReturnType<typeof findCertPrimaryDeployment>} primary
 */
export function findPeerDeployment(deployments, primary) {
  const peer = deployments.find(
    (d) => d.systemId !== primary.systemId && d.groupId === primary.groupId,
  );
  return peer ?? null;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} [siteId]
 * @param {string} [groupId]
 */
export function resolveSites(cfg, siteId, groupId) {
  const normalized = normalizeNginxWafConfig(cfg);
  const group = findDeploymentGroup(normalized, groupId);
  const sites = group.sites;
  if (!siteId) return sites;
  const id = siteId.trim();
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

/**
 * Load PEM content for custom ACME trust from acme.root_ca_file (repo-relative path).
 * @param {Record<string, unknown> | ReturnType<typeof parseAcmeSettings>} acme
 * @param {{ repoRoot?: string }} [options]
 */
export function loadAcmeRootCaContent(acme, options = {}) {
  const parsed = isObject(acme) && typeof acme.provider === "string" ? acme : parseAcmeSettings(acme);
  if (parsed.provider !== "custom" || !parsed.rootCaFile) return "";
  const root = options.repoRoot || repoRoot();
  const resolved = resolveRepoFile(root, parsed.rootCaFile.replace(/\\/g, "/"));
  if (!resolved.exists) {
    errout.write(
      `[hdc] nginx-waf: acme.root_ca_file not found: ${parsed.rootCaFile} (checked ${resolved.source})\n`,
    );
    return "";
  }
  return readFileSync(resolved.path, "utf8");
}

/** @deprecated Use hostNames */
export function serverNames(site) {
  return hostNames(site);
}
