import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveSiteAccessSettings } from "./deployments.mjs";
import { groupUsesModsecurity, modsecurityProfilePath } from "./nginx-waf-policies.mjs";
import {
  DEFAULT_SELF_SIGNED_CERT,
  DEFAULT_SELF_SIGNED_KEY,
  DEFAULT_SITE_ROOT,
  MODSECURITY_RULES_FILE,
  WAF_MAPS_FILE,
  renderDefaultCatchAllVhost,
  renderHdcNginxInclude,
  renderHdcNginxMaps,
  renderModsecurityMainConf,
  renderSiteVhost,
  hostNames,
  siteId,
  sitesNeedWebsocketMap,
} from "./nginx-waf-render.mjs";
import { certExistsOnHost } from "./letsencrypt.mjs";

const packageLibDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_404_ASSET = join(packageLibDir, "..", "assets", "default-404.html");

export { createConfigureExec };

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 120)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} remotePath
 * @param {string} content
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function uploadFile(exec, remotePath, content, log) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`, log);
}

/**
 * Upload hdc-waf.conf with OWASP CRS includes and verify CRS paths on the host.
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGlobalSettings>} opts.global
 * @param {boolean} [opts.verifyPackages]
 */
export function configureModsecurityProfiles(opts) {
  const { exec, log, global, verifyPackages = true, pruneStale = false } = opts;
  const profiles = global.groupPolicyPlan?.modsecurityProfiles || [];
  if (!profiles.length) {
    return { configured: false, profiles: [] };
  }

  if (verifyPackages && profiles.length) {
    const sample = profiles[0];
    runChecked(exec, `test -f ${shellQuote(sample.crsSetup)}`, log);
    const rulesCheck = exec.run(
      `sh -c 'ls ${String(sample.crsRulesGlob).replace(/'/g, `'\\''`)} 2>/dev/null | head -1'`,
      { capture: true },
    );
    if (rulesCheck.status !== 0 || !rulesCheck.stdout.trim()) {
      throw new Error(
        `OWASP CRS rules not found at ${sample.crsRulesGlob} — install modsecurity-crs package`,
      );
    }
  }

  runChecked(exec, "mkdir -p /etc/modsecurity /var/log/nginx", log);
  /** @type {string[]} */
  const written = [];
  for (const profile of profiles) {
    if (profile.enabled === false) continue;
    const profileId = String(profile.profileId);
    const path = modsecurityProfilePath(profileId);
    const conf = renderModsecurityMainConf({
      ruleEngine: String(profile.ruleEngine),
      crsSetup: String(profile.crsSetup),
      crsRulesGlob: String(profile.crsRulesGlob),
      unicodeMap: typeof profile.unicodeMap === "string" ? profile.unicodeMap : "",
      auditLog: String(profile.auditLog),
      auditLogFormat:
        typeof profile.auditLogFormat === "string" ? profile.auditLogFormat : "json",
      profileId,
    });
    uploadFile(exec, path, conf, log);
    runChecked(exec, `chmod 644 ${shellQuote(path)}`, log);
    written.push(path);
    runChecked(
      exec,
      `touch ${shellQuote(profile.auditLog)} && chown www-data:adm ${shellQuote(profile.auditLog)} 2>/dev/null || chown www-data:www-data ${shellQuote(profile.auditLog)} 2>/dev/null || true`,
      log,
    );
  }

  // Legacy default file for global include fallback
  const primary = profiles.find((p) => p.enabled !== false) || profiles[0];
  if (primary) {
    uploadFile(
      exec,
      MODSECURITY_RULES_FILE,
      renderModsecurityMainConf({
        ruleEngine: String(primary.ruleEngine),
        crsSetup: String(primary.crsSetup),
        crsRulesGlob: String(primary.crsRulesGlob),
        unicodeMap: typeof primary.unicodeMap === "string" ? primary.unicodeMap : "",
        auditLog: String(primary.auditLog),
        auditLogFormat:
          typeof primary.auditLogFormat === "string" ? primary.auditLogFormat : "json",
        profileId: String(primary.profileId),
      }),
      log,
    );
  }

  if (pruneStale) {
    const list = runChecked(
      exec,
      "ls -1 /etc/modsecurity/hdc-waf-*.conf 2>/dev/null || true",
      log,
    );
    for (const p of list.stdout.trim().split("\n").filter(Boolean)) {
      if (p === MODSECURITY_RULES_FILE) continue;
      if (!written.includes(p)) {
        runChecked(exec, `rm -f ${shellQuote(p)}`, log);
      }
    }
  }

  return { configured: true, profiles: written };
}

/** @deprecated Use configureModsecurityProfiles */
export function configureModsecurityCrs(opts) {
  const { exec, log, global, verifyPackages = true } = opts;
  if (!global.modsecurityEnabled) return { configured: false };
  return configureModsecurityProfiles({ exec, log, global, verifyPackages });
}

/**
 * Upload /etc/nginx/hdc/waf-global.conf and waf-maps.conf
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} opts.global
 * @param {Record<string, unknown>[]} opts.allSites
 */
export function uploadHdcNginxGlobalInclude(opts) {
  const { exec, log, global, allSites } = opts;
  runChecked(exec, "mkdir -p /etc/nginx/hdc", log);
  const plan = global.groupPolicyPlan || {
    blockCommonExploits: false,
    rateLimitZones: [],
  };
  const maps = renderHdcNginxMaps({
    websocketMapEnabled: sitesNeedWebsocketMap(allSites),
    blockCommonExploits: plan.blockCommonExploits,
    rateLimitZones: plan.rateLimitZones || [],
  });
  uploadFile(exec, WAF_MAPS_FILE, maps, log);
  const include = renderHdcNginxInclude({
    modsecurityEnabled: global.modsecurityEnabled && groupUsesModsecurity(plan),
  });
  uploadFile(exec, "/etc/nginx/hdc/waf-global.conf", include, log);
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGlobalSettings>} opts.global
 * @param {boolean} [opts.dns01]
 * @param {Record<string, unknown>[]} [opts.allSites]
 */
export function installNginxWafBase(opts) {
  const { exec, log, global, dns01, allSites = [], rootCaContent = "" } = opts;
  const pkgs = [
    "nginx",
    "libmodsecurity3",
    "libnginx-mod-http-modsecurity",
    "modsecurity-crs",
    "certbot",
    "python3-certbot-nginx",
    "rsync",
    "openssh-client",
  ];
  if (dns01) pkgs.push("python3-certbot-dns-rfc2136");
  runChecked(
    exec,
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y ${pkgs.join(" ")}`,
    log,
  );
  runChecked(exec, "mkdir -p /etc/nginx/hdc /var/www/letsencrypt", log);
  uploadHdcNginxGlobalInclude({ exec, log, global, allSites });
  runChecked(
    exec,
    `grep -q 'hdc/waf-global.conf' /etc/nginx/nginx.conf || ` +
      `sed -i '/http {/a\\    include /etc/nginx/hdc/waf-global.conf;' /etc/nginx/nginx.conf`,
    log,
  );
  runChecked(
    exec,
    "test -f /etc/letsencrypt/options-ssl-nginx.conf || " +
      "cp /usr/lib/python3/dist-clumps/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf " +
      "/etc/letsencrypt/options-ssl-nginx.conf 2>/dev/null || true",
    log,
  );
  runChecked(
    exec,
    "test -f /etc/letsencrypt/ssl-dhparams.pem || " +
      "openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048 2>/dev/null || true",
    log,
  );

  if (global.modsecurityEnabled) {
    configureModsecurityProfiles({ exec, log, global, verifyPackages: true });
  }
  installAcmeRootCa({ exec, log, global, rootCaContent });
  ensureDefaultSiteInfrastructure({ exec, log, global });
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} opts.global
 */
export function ensureDefaultSiteInfrastructure(opts) {
  const { exec, log } = opts;
  runChecked(exec, `mkdir -p ${shellQuote(DEFAULT_SITE_ROOT)} /etc/nginx/hdc`, log);
  runChecked(
    exec,
    `test -f ${shellQuote(DEFAULT_SELF_SIGNED_CERT)} || openssl req -x509 -nodes -days 3650 -newkey rsa:2048 ` +
      `-keyout ${shellQuote(DEFAULT_SELF_SIGNED_KEY)} -out ${shellQuote(DEFAULT_SELF_SIGNED_CERT)} ` +
      `-subj ${shellQuote("/CN=hdc-waf-default")}`,
    log,
  );
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} opts.global
 * @param {string} [opts.rootCaContent] PEM content for custom ACME trust
 */
export function installAcmeRootCa(opts) {
  const { exec, log, global, rootCaContent } = opts;
  if (global.acmeProvider !== "custom" || !global.rootCaPath) return { installed: false };
  if (!rootCaContent || !rootCaContent.trim()) {
    log.info(`custom ACME root CA not provided — ensure ${global.rootCaPath} exists on host`);
    return { installed: false, skipped: true };
  }
  runChecked(exec, `mkdir -p $(dirname ${shellQuote(global.rootCaPath)})`, log);
  uploadFile(exec, global.rootCaPath, rootCaContent.trim() + "\n", log);
  runChecked(exec, `chmod 644 ${shellQuote(global.rootCaPath)}`, log);
  return { installed: true, path: global.rootCaPath };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} opts.global
 */
export function configureDefaultCatchAllSite(opts) {
  const { exec, log, global } = opts;
  if (!global.defaultSiteEnabled) {
    runChecked(
      exec,
      `rm -f /etc/nginx/sites-enabled/hdc-default.conf /etc/nginx/sites-available/hdc-default.conf`,
      log,
    );
    return { enabled: false };
  }
  const html = readFileSync(DEFAULT_404_ASSET, "utf8");
  uploadFile(exec, `${DEFAULT_SITE_ROOT}/index.html`, html, log);
  const vhost = renderDefaultCatchAllVhost({ webroot: DEFAULT_SITE_ROOT });
  const avail = "/etc/nginx/sites-available/hdc-default.conf";
  uploadFile(exec, avail, vhost, log);
  runChecked(exec, `ln -sf ${shellQuote(avail)} /etc/nginx/sites-enabled/hdc-default.conf`, log);
  runChecked(
    exec,
    "rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default 2>/dev/null || true",
    log,
  );
  return { enabled: true, path: avail };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGlobalSettings>} opts.global
 * @param {Record<string, unknown>[]} opts.sites
 * @param {Record<string, unknown>[]} [opts.allSites] Full site list for global WebSocket map (defaults to sites)
 * @param {boolean} [opts.pruneStaleSites] Remove hdc-* vhosts on host not in sites[] (default true)
 * @param {string} [opts.wafNodeId] deployment.system_id baked into upstream headers
 */
export function configureNginxWafSites(opts) {
  const { exec, log, global, sites, allSites = sites, pruneStaleSites = true, wafNodeId } = opts;
  runChecked(exec, "mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled", log);
  uploadHdcNginxGlobalInclude({ exec, log, global, allSites });

  /** @type {string[]} */
  const enabledIds = [];

  configureDefaultCatchAllSite({ exec, log, global });

  for (const site of sites) {
    const id = siteId(site);
    const tls = site.tls && typeof site.tls === "object" ? site.tls : {};
    const certName =
      typeof tls.cert_name === "string" && tls.cert_name.trim()
        ? tls.cert_name.trim()
        : hostNames(site)[0];
    const deferTls = tls.enabled !== false && !certExistsOnHost(exec, certName);
    const access = resolveSiteAccessSettings(site, global);
    const vhost = renderSiteVhost({
      site,
      modsecurityEnabled: global.modsecurityEnabled,
      http01Acme: global.challenge === "http-01",
      webroot: global.webroot,
      deferTlsUntilCertExists: deferTls,
      clientIp: access.clientIp,
      cloudflareIpv4: access.cloudflareIpv4,
      wafNodeId,
      policyCatalog: global.policyDefinitions,
    });
    const avail = `/etc/nginx/sites-available/hdc-${id}.conf`;
    uploadFile(exec, avail, vhost, log);
    runChecked(exec, `ln -sf ${shellQuote(avail)} /etc/nginx/sites-enabled/hdc-${id}.conf`, log);
    enabledIds.push(id);
  }

  if (pruneStaleSites) {
    const list = runChecked(
      exec,
      "ls -1 /etc/nginx/sites-enabled/hdc-*.conf 2>/dev/null || true",
      log,
    );
    const existing = list.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => {
        const m = p.match(/hdc-([^.]+)\.conf$/);
        return m ? m[1] : null;
      })
      .filter(Boolean);

    for (const oldId of existing) {
      if (oldId === "default") continue;
      if (!enabledIds.includes(/** @type {string} */ (oldId))) {
        runChecked(
          exec,
          `rm -f /etc/nginx/sites-enabled/hdc-${oldId}.conf /etc/nginx/sites-available/hdc-${oldId}.conf`,
          log,
        );
        log.info(`removed stale site ${oldId}`);
      }
    }
  }

  runChecked(exec, "nginx -t", log);
  runChecked(
    exec,
    "systemctl enable nginx && (systemctl is-active --quiet nginx && systemctl reload nginx || systemctl start nginx)",
    log,
  );
  return { enabled_site_ids: enabledIds, prune_stale_sites: pruneStaleSites };
}

/**
 * Full configure: base + sites.
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGlobalSettings>} opts.global
 * @param {Record<string, unknown>[]} opts.sites
 * @param {boolean} [opts.skipBaseInstall]
 * @param {string} [opts.wafNodeId]
 */
export function configureNginxWaf(opts) {
  const { exec, log, global, sites, skipBaseInstall, wafNodeId, rootCaContent = "" } = opts;
  if (!skipBaseInstall) {
    installNginxWafBase({
      exec,
      log,
      global,
      dns01: global.challenge === "dns-01",
      allSites: sites,
      rootCaContent,
    });
  } else if (global.modsecurityEnabled) {
    configureModsecurityProfiles({ exec, log, global, verifyPackages: false });
  }
  const sitesResult = configureNginxWafSites({ exec, log, global, sites, allSites: sites, wafNodeId });
  return { ...sitesResult };
}

/**
 * Re-apply OWASP CRS ModSecurity config without apt (maintain default path).
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGlobalSettings>} opts.global
 */
export function maintainModsecurityCrs(opts) {
  const { exec, log, global } = opts;
  if (!global.modsecurityEnabled) return { configured: false };
  return configureModsecurityProfiles({
    exec,
    log,
    global,
    verifyPackages: false,
    pruneStale: true,
  });
}
