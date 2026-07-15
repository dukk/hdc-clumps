import {
  normalizeSourceCidr,
  parseIpv4Cidr,
} from "../../../infrastructure/proxmox/lib/proxmox-host-firewall-maintain.mjs";
import { CLOUDFLARE_IPV4_CIDRS } from "./cloudflare-ip-ranges.mjs";
import {
  modsecurityProfilePath,
  resolveLocationPolicyPlan,
  resolveSitePolicyPlan,
  trustedGeoVariableForSite,
} from "./nginx-waf-policies.mjs";

/** HDC-managed ModSecurity main config (includes OWASP CRS). */
export const MODSECURITY_RULES_FILE = "/etc/modsecurity/hdc-waf.conf";
export const WAF_GLOBAL_FILE = "/etc/nginx/hdc/waf-global.conf";
export const WAF_MAPS_FILE = "/etc/nginx/hdc/waf-maps.conf";

export const DEFAULT_CRS_SETUP = "/etc/modsecurity/crs/crs-setup.conf";
export const DEFAULT_CRS_RULES_GLOB = "/usr/share/modsecurity-crs/rules/*.conf";
/** Optional; Ubuntu 24.04+ modsecurity-crs omits this file — leave unset to skip SecUnicodeMapFile. */
export const DEFAULT_UNICODE_MAP = "";
export const DEFAULT_MODSEC_AUDIT_LOG = "/var/log/nginx/modsec_audit.log";

export const TRUSTED_GEO_VARIABLE = "$hdc_trusted_internal";

export const DEFAULT_SITE_HTML_PATH = "/var/www/hdc-default/index.html";
export const DEFAULT_SITE_ROOT = "/var/www/hdc-default";
export const DEFAULT_SELF_SIGNED_CERT = "/etc/nginx/hdc/default-selfsigned.crt";
export const DEFAULT_SELF_SIGNED_KEY = "/etc/nginx/hdc/default-selfsigned.key";

/** @type {Set<string>} */
const legacyHostNameWarnings = new Set();

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} site
 */
export function migrateSiteHostNames(site) {
  const out = { ...site };
  if (!Array.isArray(out.host_names) || !out.host_names.length) {
    if (Array.isArray(out.server_names) && out.server_names.length) {
      if (!legacyHostNameWarnings.has("server_names")) {
        legacyHostNameWarnings.add("server_names");
        process.stderr.write(
          "[hdc] nginx-waf: server_names is deprecated — rename to host_names in config\n",
        );
      }
      out.host_names = out.server_names;
    }
  }
  return out;
}

/**
 * @param {string[]} cidrs
 * @param {string} context
 */
export function validateTrustedCidrs(cidrs, context) {
  if (!cidrs.length) {
    throw new Error(`${context}: trusted_cidrs must include at least one CIDR`);
  }
  for (const cidr of cidrs) {
    const normalized = normalizeSourceCidr(cidr);
    if (!parseIpv4Cidr(normalized)) {
      throw new Error(`${context}: invalid trusted CIDR ${JSON.stringify(cidr)}`);
    }
  }
}

/**
 * @param {Record<string, unknown>[]} locations
 */
export function siteHasInternalOnlyAccess(locations) {
  return locations.some((loc) => {
    const access = isObject(loc.access) ? loc.access : null;
    return access?.policy === "internal_only";
  });
}

/**
 * @param {Record<string, unknown>} loc
 * @param {string} context
 * @returns {{ denyStatus: 401 | 404 } | null}
 */
export function parseLocationAccess(loc, context) {
  const access = isObject(loc.access) ? loc.access : null;
  if (!access) return null;
  const policy = typeof access.policy === "string" ? access.policy.trim() : "";
  if (policy !== "internal_only") {
    throw new Error(`${context}: location access.policy must be internal_only`);
  }
  const denyRaw = access.deny_status;
  const denyStatus = denyRaw === 401 || denyRaw === 404 ? denyRaw : null;
  if (!denyStatus) {
    throw new Error(`${context}: location access.deny_status must be 401 or 404`);
  }
  return { denyStatus };
}

/**
 * @param {object} opts
 * @param {string[]} opts.cidrs
 * @param {"remote_addr" | "cloudflare"} opts.clientIp
 */
export function renderTrustedGeo(opts) {
  const { cidrs, clientIp } = opts;
  const geoSource = clientIp === "cloudflare" ? "$realip_remote_addr" : "$remote_addr";
  const lines = [`geo ${geoSource} $hdc_trusted_internal {`, "    default 0;"];
  for (const cidr of cidrs) {
    lines.push(`    ${normalizeSourceCidr(cidr)} 1;`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/**
 * @param {boolean} cloudflareIpv4
 */
export function renderCloudflareRealIp(cloudflareIpv4) {
  if (!cloudflareIpv4) {
    throw new Error("client_ip cloudflare requires defaults.nginx_waf.cloudflare_ipv4 (not false)");
  }
  const lines = ["    # Cloudflare client IP (hdc nginx-waf)"];
  for (const cidr of CLOUDFLARE_IPV4_CIDRS) {
    lines.push(`    set_real_ip_from ${cidr};`);
  }
  lines.push(
    "    real_ip_header CF-Connecting-IP;",
    "    real_ip_recursive on;",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * @param {object} opts
 * @param {string} [opts.wafNodeId]
 */
export function renderProxyHeaders(opts) {
  const { wafNodeId } = opts;
  const nodeLine =
    typeof wafNodeId === "string" && wafNodeId.trim()
      ? `
        proxy_set_header X-HDC-Nginx-Waf-Node ${wafNodeId.trim()};`
      : "";
  return `
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;${nodeLine}`;
}

/**
 * @param {object} opts
 * @param {string} opts.ruleEngine
 * @param {string} opts.crsSetup
 * @param {string} opts.crsRulesGlob
 * @param {string} opts.unicodeMap
 * @param {string} opts.auditLog
 * @param {string} [opts.auditLogFormat]
 */
export function renderModsecurityMainConf(opts) {
  const { ruleEngine, crsSetup, crsRulesGlob, unicodeMap, auditLog, profileId, auditLogFormat } = opts;
  const header =
    profileId && profileId !== "default"
      ? `# Managed by hdc nginx-waf — profile ${profileId}`
      : "# Managed by hdc nginx-waf — do not edit manually";
  const auditFormatLine =
    typeof auditLogFormat === "string" && auditLogFormat.trim().toLowerCase() === "json"
      ? "SecAuditLogFormat JSON"
      : null;
  return [
    header,
    `SecRuleEngine ${ruleEngine}`,
    "SecRequestBodyAccess On",
    "SecResponseBodyAccess Off",
    "SecAuditEngine RelevantOnly",
    `SecAuditLog ${auditLog}`,
    ...(auditFormatLine ? [auditFormatLine] : []),
    ...(unicodeMap && unicodeMap.trim() ? [`SecUnicodeMapFile ${unicodeMap.trim()} 20127`] : []),
    `Include ${crsSetup}`,
    `Include ${crsRulesGlob}`,
    "",
  ].join("\n");
}

/** Shared http-level map blocking common exploit URI patterns. */
export function renderExploitPathMap() {
  return `map $request_uri $hdc_blocked_exploit_path {
    "~*//"                                                      1;
    "~*(boot.ini|etc/passwd|self/environ)"                      1;
    "~*(%2e%2e|%252e%252e|%u002e|%c0%2e)"                       1;
    "~*(\\.\\./\\.\\./|\\.\\.\\.|%252e%252e%252e)"                     1;
    "~*(~|\`|\\<|\\>|:|;|\\{|\\}|\\[|\\]|\\(|\\))"                           1;
    default 0;
}

`;
}

/**
 * @param {Record<string, unknown>[]} zones
 */
export function renderRateLimitZones(zones) {
  if (!zones.length) return "";
  const lines = [];
  for (const z of zones) {
    const zoneName = String(z.zoneName);
    const key = typeof z.key === "string" ? z.key : "$binary_remote_addr";
    const rate = typeof z.rate === "string" ? z.rate : "10r/s";
    const zoneSize = typeof z.zoneSize === "string" ? z.zoneSize : "10m";
    lines.push(`limit_req_zone ${key} zone=${zoneName}:${zoneSize} rate=${rate};`);
  }
  return `${lines.join("\n")}\n\n`;
}

/**
 * @param {object} opts
 * @param {boolean} opts.websocketMapEnabled
 * @param {boolean} opts.blockCommonExploits
 * @param {Record<string, unknown>[]} opts.rateLimitZones
 */
export function renderHdcNginxMaps(opts) {
  const { websocketMapEnabled, blockCommonExploits, rateLimitZones } = opts;
  const parts = ["# Managed by hdc nginx-waf — http maps and zones\n"];
  if (websocketMapEnabled) {
    parts.push(renderWebsocketUpgradeMap());
  }
  if (blockCommonExploits) {
    parts.push(renderExploitPathMap());
  }
  parts.push(renderRateLimitZones(rateLimitZones));
  return parts.join("");
}

/**
 * @param {object} opts
 * @param {string[]} opts.cidrs
 * @param {"remote_addr" | "cloudflare"} opts.clientIp
 * @param {string} opts.geoVariable e.g. $hdc_trusted_vaultwarden
 */
export function renderTrustedGeoForPolicy(opts) {
  const { cidrs, clientIp, geoVariable } = opts;
  const geoSource = clientIp === "cloudflare" ? "$realip_remote_addr" : "$remote_addr";
  const varName = geoVariable.startsWith("$") ? geoVariable.slice(1) : geoVariable;
  const lines = [`geo ${geoSource} ${geoVariable} {`, "    default 0;"];
  for (const cidr of cidrs) {
    lines.push(`    ${normalizeSourceCidr(cidr)} 1;`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} sitePlan
 * @param {{ skipCloudflareOrigin?: boolean }} [opts]
 */
export function renderPolicyServerDirectives(sitePlan, opts = {}) {
  const { skipCloudflareOrigin = false } = opts;
  /** @type {string[]} */
  const lines = [];
  const ms = sitePlan.modsecurity;
  if (ms && ms.enabled !== false) {
    lines.push(`modsecurity_rules_file ${modsecurityProfilePath(String(ms.profileId))};`);
  } else {
    // Override http-level modsecurity on when this site omits modsecurity-default.
    lines.push("modsecurity off;");
  }
  if (sitePlan.server_tokens?.serverTokensOff) {
    lines.push("server_tokens off;");
  }
  const buf = sitePlan.client_buffers;
  if (buf) {
    if (buf.clientBodyBufferSize) lines.push(`client_body_buffer_size ${buf.clientBodyBufferSize};`);
    if (buf.clientHeaderBufferSize) {
      lines.push(`client_header_buffer_size ${buf.clientHeaderBufferSize};`);
    }
    if (buf.largeClientHeaderBuffers) {
      lines.push(`large_client_header_buffers ${buf.largeClientHeaderBuffers};`);
    }
  }
  const cf = sitePlan.cloudflare_origin;
  if (cf?.requireHeaders && !skipCloudflareOrigin) {
    const deny = typeof cf.denyStatus === "number" ? cf.denyStatus : 403;
    lines.push(`if ($http_cf_connecting_ip = "") { return ${deny}; }`);
    if (cf.requireCfRay) {
      lines.push(`if ($http_cf_ray = "") { return ${deny}; }`);
    }
  }
  const hp = sitePlan.http_protocol;
  if (hp?.minVersion === "1.1") {
    const deny = typeof hp.denyStatus === "number" ? hp.denyStatus : 505;
    lines.push(`if ($server_protocol = HTTP/1.0) { return ${deny}; }`);
  }
  if (sitePlan.block_common_exploits) {
    lines.push("if ($hdc_blocked_exploit_path) { return 444; }");
  }
  if (!lines.length) return "";
  return `\n    ${lines.join("\n    ")}\n`;
}

/**
 * @param {Record<string, unknown>} locPlan
 * @param {string} geoVariable
 */
export function renderPolicyLocationDirectives(locPlan, geoVariable) {
  /** @type {string[]} */
  const parts = [];
  const ms = locPlan.modsecurity;
  if (ms && ms.enabled === false) {
    parts.push("modsecurity off;");
  }
  const tc = locPlan.trusted_cidrs;
  if (tc) {
    parts.push(`if (${geoVariable} = 0) { return ${tc.denyStatus}; }`);
  }
  const rl = locPlan.rate_limit;
  if (rl) {
    const burst = typeof rl.burst === "number" ? rl.burst : 20;
    const nodelay = rl.nodelay !== false ? " nodelay" : "";
    parts.push(`limit_req zone=${rl.zoneName} burst=${burst}${nodelay};`);
  }
  if (!parts.length) return "";
  return `\n        ${parts.join("\n        ")}`;
}

/**
 * @param {Record<string, unknown>} site
 */
export function siteId(site) {
  const id = typeof site.id === "string" ? site.id.trim() : "";
  if (!id) throw new Error("site needs id");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`site id ${JSON.stringify(id)} must be lowercase slug`);
  }
  return id;
}

/**
 * @param {Record<string, unknown>} site
 */
export function hostNames(site) {
  const migrated = migrateSiteHostNames(site);
  const names = Array.isArray(migrated.host_names)
    ? migrated.host_names.map((n) => String(n).trim()).filter(Boolean)
    : [];
  if (!names.length) throw new Error(`${siteId(site)}: host_names required`);
  return names;
}

/** @deprecated Use hostNames */
export function serverNames(site) {
  return hostNames(site);
}

/**
 * @param {unknown} raw
 * @param {string} context
 */
export function parseUpstream(raw, context) {
  if (typeof raw === "string" && raw.trim()) {
    return {
      type: /** @type {const} */ ("direct"),
      proxyPass: raw.trim(),
      scheme: null,
    };
  }
  if (!isObject(raw)) {
    throw new Error(`${context}: upstream required (string URL or object with servers[])`);
  }
  const serversRaw = Array.isArray(raw.servers) ? raw.servers.filter(isObject) : [];
  if (!serversRaw.length) {
    throw new Error(`${context}: upstream.servers must include at least one server`);
  }
  /** @type {{ host: string, port: number, scheme: string, weight?: number, maxFails?: number, failTimeout?: string, backup?: boolean, down?: boolean }[]} */
  const servers = [];
  for (const [idx, entry] of serversRaw.entries()) {
    const url =
      typeof entry.url === "string" && entry.url.trim()
        ? entry.url.trim()
        : typeof entry.address === "string" && entry.address.trim()
          ? entry.address.trim()
          : "";
    if (!url) {
      throw new Error(`${context}: upstream.servers[${idx}] needs url or address`);
    }
    let parsed;
    try {
      parsed = new URL(url.includes("://") ? url : `http://${url}`);
    } catch {
      throw new Error(`${context}: upstream.servers[${idx}] invalid URL ${JSON.stringify(url)}`);
    }
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    /** @type {typeof servers[number]} */
    const server = {
      host: parsed.hostname,
      port,
      scheme: parsed.protocol.replace(":", ""),
    };
    if (typeof entry.weight === "number") server.weight = entry.weight;
    if (typeof entry.max_fails === "number") server.maxFails = entry.max_fails;
    if (typeof entry.fail_timeout === "string" && entry.fail_timeout.trim()) {
      server.failTimeout = entry.fail_timeout.trim();
    }
    if (entry.backup === true) server.backup = true;
    if (entry.down === true) server.down = true;
    servers.push(server);
  }
  const methodRaw =
    typeof raw.method === "string" ? raw.method.trim().toLowerCase() : "round_robin";
  const allowed = new Set(["round_robin", "least_conn", "ip_hash", "hash", "random"]);
  if (!allowed.has(methodRaw)) {
    throw new Error(`${context}: upstream.method must be one of ${[...allowed].join(", ")}`);
  }
  return {
    type: /** @type {const} */ ("pool"),
    method: methodRaw,
    hashKey: typeof raw.hash_key === "string" ? raw.hash_key.trim() : "",
    keepalive: typeof raw.keepalive === "number" ? raw.keepalive : undefined,
    servers,
    scheme: servers[0]?.scheme ?? "http",
  };
}

/**
 * @param {string} blockName
 * @param {ReturnType<typeof parseUpstream> & { type: "pool" }} pool
 */
export function renderUpstreamBlock(blockName, pool) {
  const lines = [`upstream ${blockName} {`];
  if (pool.method === "least_conn") lines.push("    least_conn;");
  else if (pool.method === "ip_hash") lines.push("    ip_hash;");
  else if (pool.method === "hash") {
    const key = pool.hashKey || "$request_uri";
    lines.push(`    hash ${key};`);
  } else if (pool.method === "random") lines.push("    random two least_conn;");
  if (pool.keepalive && pool.keepalive > 0) {
    lines.push(`    keepalive ${pool.keepalive};`);
  }
  for (const s of pool.servers) {
    const parts = [`server ${s.host}:${s.port}`];
    if (typeof s.weight === "number") parts.push(`weight=${s.weight}`);
    if (typeof s.maxFails === "number") parts.push(`max_fails=${s.maxFails}`);
    if (s.failTimeout) parts.push(`fail_timeout=${s.failTimeout}`);
    if (s.backup) parts.push("backup");
    if (s.down) parts.push("down");
    lines.push(`    ${parts.join(" ")};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/**
 * @param {ReturnType<typeof parseUpstream>} upstream
 * @param {string} blockName
 */
function renderProxyPassDirective(upstream, blockName) {
  if (upstream.type === "direct") {
    return upstream.proxyPass;
  }
  const scheme = upstream.scheme === "https" ? "https" : "http";
  return `${scheme}://${blockName}`;
}

/**
 * @param {ReturnType<typeof parseUpstream>} upstream
 */
function renderProxySslLines(upstream) {
  if (upstream.type === "pool" && upstream.scheme === "https") {
    return `
        proxy_ssl on;
        proxy_ssl_server_name on;`;
  }
  return "";
}

/**
 * @param {Record<string, unknown>[]} sites
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} [groupGlobal]
 */
export function tlsDomainsFromSites(sites, groupGlobal) {
  /** @type {string[]} */
  const domains = [];
  for (const site of sites) {
    const tls = isObject(site.tls) ? site.tls : {};
    if (tls.enabled === false) continue;
    const certName =
      typeof tls.cert_name === "string" && tls.cert_name.trim()
        ? tls.cert_name.trim()
        : hostNames(site)[0];
    if (certName && !domains.includes(certName)) domains.push(certName);
  }
  return domains;
}

/**
 * @param {Record<string, unknown>} site
 */
export function siteHasWebsocketLocations(site) {
  const locations = Array.isArray(site.locations) ? site.locations.filter(isObject) : [];
  return locations.some((loc) => loc.websocket === true);
}

/**
 * @param {Record<string, unknown>[]} sites
 */
export function sitesNeedWebsocketMap(sites) {
  return sites.some((site) => siteHasWebsocketLocations(site));
}

/**
 * HTTP/2 with WebSocket upgrade headers or ModSecurity on nginx-mod-http-modsecurity
 * can crash workers (bogus malloc sizes / empty replies). Default off unless tls.http2 is true.
 *
 * @param {Record<string, unknown>} tls
 * @param {Record<string, unknown>} site
 * @param {Record<string, unknown>} sitePlan
 * @param {boolean} modsecurityGloballyOn
 */
export function resolveTlsHttp2Enabled(tls, site, sitePlan, modsecurityGloballyOn) {
  if (tls.http2 === true) return true;
  if (tls.http2 === false) return false;
  if (siteHasWebsocketLocations(site)) return false;
  if (modsecurityGloballyOn && sitePlan.modsecurity?.enabled !== false) return false;
  return true;
}

/** @returns {string} */
export function renderWebsocketUpgradeMap() {
  return `map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

`;
}

/**
 * @param {object} opts
 * @param {boolean} opts.modsecurityEnabled
 * @param {boolean} [opts.websocketMapEnabled]
 */
export function renderHdcNginxInclude(opts) {
  const { modsecurityEnabled } = opts;
  const lines = [
    "# Managed by hdc nginx-waf — do not edit manually",
    `include ${WAF_MAPS_FILE};`,
    "client_max_body_size 64m;",
    "proxy_read_timeout 300s;",
    "proxy_connect_timeout 60s;",
  ];
  if (modsecurityEnabled) {
    lines.push("modsecurity on;");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.webroot]
 */
export function renderDefaultCatchAllVhost(opts = {}) {
  const webroot = opts.webroot ?? DEFAULT_SITE_ROOT;
  return `# hdc default catch-all (unmatched host)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    modsecurity off;
    location / {
        root ${webroot};
        try_files /index.html =404;
        default_type text/html;
    }
}

server {
    listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;
    server_name _;
    modsecurity off;
    ssl_certificate ${DEFAULT_SELF_SIGNED_CERT};
    ssl_certificate_key ${DEFAULT_SELF_SIGNED_KEY};
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    location / {
        root ${webroot};
        try_files /index.html =404;
        default_type text/html;
    }
}
`;
}

/**
 * Per-site upload/proxy timeout overrides (server block); omitted when unset.
 * @param {Record<string, unknown>} site
 * @returns {string}
 */
export function renderSiteUploadDirectives(site) {
  /** @type {string[]} */
  const lines = [];
  const bodySize =
    typeof site.client_max_body_size === "string" && site.client_max_body_size.trim()
      ? site.client_max_body_size.trim()
      : "";
  const readTimeout =
    typeof site.proxy_read_timeout === "string" && site.proxy_read_timeout.trim()
      ? site.proxy_read_timeout.trim()
      : "";
  const connectTimeout =
    typeof site.proxy_connect_timeout === "string" && site.proxy_connect_timeout.trim()
      ? site.proxy_connect_timeout.trim()
      : "";
  if (bodySize) lines.push(`    client_max_body_size ${bodySize};`);
  if (readTimeout) lines.push(`    proxy_read_timeout ${readTimeout};`);
  if (connectTimeout) lines.push(`    proxy_connect_timeout ${connectTimeout};`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.site
 * @param {boolean} opts.modsecurityEnabled
 * @param {boolean} opts.http01Acme
 * @param {string} opts.webroot
 * @param {boolean} [opts.deferTlsUntilCertExists]
 * @param {"remote_addr" | "cloudflare"} [opts.clientIp]
 * @param {boolean} [opts.cloudflareIpv4]
 * @param {string} [opts.wafNodeId]
 * @param {Record<string, Record<string, unknown>>} opts.policyCatalog
 */
export function renderSiteVhost(opts) {
  const {
    site,
    modsecurityEnabled,
    http01Acme,
    webroot,
    deferTlsUntilCertExists = false,
    clientIp = "remote_addr",
    cloudflareIpv4 = true,
    wafNodeId,
    policyCatalog,
  } = opts;
  const id = siteId(site);
  const names = hostNames(site);
  const listen = Array.isArray(site.listen)
    ? site.listen.map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0)
    : [80, 443];
  const siteUpstream = parseUpstream(site.upstream, id);

  const tls = isObject(site.tls) ? site.tls : {};
  const tlsEnabled = tls.enabled !== false && !deferTlsUntilCertExists;
  const httpRedirect = tls.enabled !== false && tls.http_redirect !== false;
  const certName =
    typeof tls.cert_name === "string" && tls.cert_name.trim()
      ? tls.cert_name.trim()
      : names[0];

  const catalog = policyCatalog || {};
  const sitePlan = resolveSitePolicyPlan(site, catalog, id);
  const geoVariable = trustedGeoVariableForSite(id);
  const siteClientIp =
    typeof site.client_ip === "string" && site.client_ip.trim().toLowerCase() === "cloudflare"
      ? "cloudflare"
      : clientIp;

  const locations = Array.isArray(site.locations) ? site.locations.filter(isObject) : [];
  let needsTrustedGeo = false;
  /** @type {string[]} */
  let trustedUnionCidrs = [];
  for (let i = 0; i < (locations.length || 1); i++) {
    const loc = locations[i] || { path: "/" };
    const locPlan = resolveLocationPolicyPlan(site, loc, i, catalog, sitePlan);
    if (locPlan.trusted_cidrs) {
      needsTrustedGeo = true;
      const tc = /** @type {{ unionCidrs: string[] }} */ (locPlan.trusted_cidrs);
      for (const c of tc.unionCidrs) {
        if (!trustedUnionCidrs.includes(c)) trustedUnionCidrs.push(c);
      }
    }
  }

  /** @type {string[]} */
  const upstreamBlocks = [];
  const defaultBlockName =
    siteUpstream.type === "pool" ? `hdc_${id.replace(/-/g, "_")}` : "";

  if (siteUpstream.type === "pool") {
    upstreamBlocks.push(renderUpstreamBlock(defaultBlockName, siteUpstream));
  }

  const resolveLocUpstream = (loc, index) => {
    if (loc.upstream !== undefined) {
      const parsed = parseUpstream(loc.upstream, `${id} location ${index}`);
      if (parsed.type === "pool") {
        const blockName = `hdc_${id.replace(/-/g, "_")}_loc_${index}`;
        upstreamBlocks.push(renderUpstreamBlock(blockName, parsed));
        return { parsed, blockName };
      }
      return { parsed, blockName: "" };
    }
    return { parsed: siteUpstream, blockName: defaultBlockName };
  };

  const serverDirectives = renderPolicyServerDirectives(sitePlan);
  const serverDirectivesHttp80 =
    http01Acme && listen.includes(80)
      ? renderPolicyServerDirectives(sitePlan, { skipCloudflareOrigin: true })
      : serverDirectives;
  const modsecGloballyOn = modsecurityEnabled && sitePlan.modsecurity?.enabled !== false;
  const http2Enabled = resolveTlsHttp2Enabled(tls, site, sitePlan, modsecurityEnabled);
  const http2ListenSuffix = http2Enabled ? " http2" : "";
  const uploadDirectives = renderSiteUploadDirectives(site);
  const httpProxiesOn80 = deferTlsUntilCertExists || !httpRedirect;

  const renderLoc = (loc, index) => {
    const { parsed, blockName } = resolveLocUpstream(loc, index);
    const proxyPass = renderProxyPassDirective(parsed, blockName);
    const locPlan = resolveLocationPolicyPlan(site, loc, index, catalog, sitePlan);
    return renderLocationBlock(loc, proxyPass, parsed, locPlan, geoVariable, wafNodeId);
  };

  const locBlocks =
    locations.length > 0
      ? locations.map((loc, i) => renderLoc(loc, i))
      : [
          renderLocationBlock(
            { path: "/", proxy_headers: true },
            renderProxyPassDirective(siteUpstream, defaultBlockName),
            siteUpstream,
            sitePlan,
            geoVariable,
            wafNodeId,
          ),
        ];

  const trustedGeoBlock = needsTrustedGeo
    ? `${renderTrustedGeoForPolicy({ cidrs: trustedUnionCidrs, clientIp: siteClientIp, geoVariable })}\n`
    : "";
  const cloudflareRealIp =
    siteClientIp === "cloudflare" ? renderCloudflareRealIp(cloudflareIpv4) : "";

  /** @type {string[]} */
  const blocks = [];

  if (listen.includes(80)) {
    const acme =
      http01Acme && webroot
        ? `
    location ^~ /.well-known/acme-challenge/ {
        root ${webroot};
        default_type "text/plain";
    }`
        : "";
    const locBlocksHttp =
      locations.length > 0
        ? locations.map((loc, i) => renderLoc(loc, i))
        : [
            renderLocationBlock(
              { path: "/", proxy_headers: true },
              renderProxyPassDirective(siteUpstream, defaultBlockName),
              siteUpstream,
              sitePlan,
              geoVariable,
              wafNodeId,
            ),
          ];
    let httpServe;
    if (deferTlsUntilCertExists) {
      httpServe = locBlocksHttp.join("\n");
    } else if (httpRedirect && tlsEnabled) {
      httpServe = `
    location / {
        return 301 https://$host$request_uri;
    }`;
    } else if (!httpRedirect) {
      httpServe = locBlocksHttp.join("\n");
    } else {
      httpServe = `
    location / {
        return 301 https://$host$request_uri;
    }`;
    }
    blocks.push(`server {
    listen 80;
    listen [::]:80;
    server_name ${names.join(" ")};${serverDirectivesHttp80}${httpProxiesOn80 ? uploadDirectives : ""}
${acme}${cloudflareRealIp}${httpServe}
}
`);
  }

  if (listen.includes(443) && tlsEnabled) {
    blocks.push(`server {
    listen 443 ssl${http2ListenSuffix};
    listen [::]:443 ssl${http2ListenSuffix};
    server_name ${names.join(" ")};${serverDirectives}${uploadDirectives}
    ssl_certificate /etc/letsencrypt/live/${certName}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${certName}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
${cloudflareRealIp}${locBlocks.join("\n")}
}
`);
  } else if (!listen.includes(80)) {
    blocks.push(`server {
    listen ${listen[0]};
    server_name ${names.join(" ")};${serverDirectives}${uploadDirectives}
${locBlocks.join("\n")}
}
`);
  }

  const upstreamPrefix = upstreamBlocks.length ? `${upstreamBlocks.join("\n")}\n` : "";
  return `# hdc site ${id}\n${upstreamPrefix}${trustedGeoBlock}${blocks.join("\n")}`;
}

/**
 * @param {Record<string, unknown>} loc
 * @param {string} proxyPass
 * @param {ReturnType<typeof parseUpstream>} upstreamParsed
 * @param {Record<string, unknown>} locPlan
 * @param {string} geoVariable
 * @param {string} [wafNodeId]
 */
function renderLocationBlock(loc, proxyPass, upstreamParsed, locPlan, geoVariable, wafNodeId) {
  const path = typeof loc.path === "string" && loc.path.trim() ? loc.path.trim() : "/";
  const policyLines = renderPolicyLocationDirectives(locPlan, geoVariable);
  const headers = loc.proxy_headers !== false;
  const headerLines = headers ? renderProxyHeaders({ wafNodeId }) : "";
  const websocket = loc.websocket === true;
  const websocketLines = websocket
    ? `
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_cache_bypass $http_upgrade;`
    : "";
  const sslLines = renderProxySslLines(upstreamParsed);
  return `    location ${path} {${policyLines}
        proxy_pass ${proxyPass};${headerLines}${sslLines}${websocketLines}
    }`;
}

/**
 * @param {object} opts
 * @param {string} opts.dnsZone
 * @param {string} opts.dnsNameserver
 * @param {string} opts.keyName
 * @param {string} opts.tsigSecret
 */
export function renderCertbotDnsCredentials(opts) {
  const { dnsZone, dnsNameserver, keyName, tsigSecret } = opts;
  return [
    `dns_rfc2136_server = ${dnsNameserver}`,
    `dns_rfc2136_port = 53`,
    `dns_rfc2136_name = ${keyName}`,
    `dns_rfc2136_secret = ${tsigSecret}`,
    `dns_rfc2136_algorithm = HMAC-SHA256`,
    `dns_rfc2136_zone = ${dnsZone}`,
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {string} opts.peerUser
 * @param {string} opts.peerHost
 */
export function renderCertSyncScript(opts) {
  const { peerUser, peerHost } = opts;
  const peer = `${peerUser}@${peerHost}`;
  return `#!/bin/bash
# hdc nginx-waf — sync ACME certs to peer and reload nginx
set -euo pipefail
PEER=${JSON.stringify(peer)}
RSYNC_OPTS="-az --delete"
for dir in live archive; do
  if [ -d "/etc/letsencrypt/\${dir}" ]; then
    rsync \${RSYNC_OPTS} "/etc/letsencrypt/\${dir}/" "\${PEER}:/etc/letsencrypt/\${dir}/"
  fi
done
nginx -t
nginx -s reload
ssh "\${PEER}" 'nginx -t && nginx -s reload'
`;
}
