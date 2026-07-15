/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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
export function serverNames(site) {
  const names = Array.isArray(site.server_names)
    ? site.server_names.map((n) => String(n).trim()).filter(Boolean)
    : [];
  if (!names.length) throw new Error(`${siteId(site)}: server_names required`);
  return names;
}

/**
 * @param {Record<string, unknown>} site
 */
export function staticRoot(site) {
  const st = isObject(site.static) ? site.static : {};
  return typeof st.root === "string" && st.root.trim() ? st.root.trim() : "";
}

/**
 * @param {Record<string, unknown>} site
 */
export function staticIndex(site) {
  const st = isObject(site.static) ? site.static : {};
  return typeof st.index === "string" && st.index.trim() ? st.index.trim() : "index.html";
}

/**
 * @param {Record<string, unknown>} site
 */
export function isStaticSite(site) {
  return staticRoot(site) !== "";
}

/**
 * @param {Record<string, unknown>[]} sites
 */
export function staticDocrootsFromSites(sites) {
  /** @type {string[]} */
  const roots = [];
  for (const site of sites) {
    const root = staticRoot(site);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * @param {Record<string, unknown>[]} sites
 */
export function tlsDomainsFromSites(sites) {
  /** @type {string[]} */
  const domains = [];
  for (const site of sites) {
    const tls = isObject(site.tls) ? site.tls : {};
    if (tls.enabled === false) continue;
    const certName =
      typeof tls.cert_name === "string" && tls.cert_name.trim()
        ? tls.cert_name.trim()
        : serverNames(site)[0];
    if (certName && !domains.includes(certName)) domains.push(certName);
  }
  return domains;
}

/**
 * @param {object} opts
 * @param {string} opts.clientMaxBodySize
 * @param {string} opts.proxyReadTimeout
 * @param {string} opts.proxyConnectTimeout
 */
export function renderHdcNginxInclude(opts) {
  const { clientMaxBodySize, proxyReadTimeout, proxyConnectTimeout } = opts;
  return [
    "# Managed by hdc nginx — do not edit manually",
    `client_max_body_size ${clientMaxBodySize};`,
    `proxy_read_timeout ${proxyReadTimeout};`,
    `proxy_connect_timeout ${proxyConnectTimeout};`,
    "",
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.site
 * @param {boolean} opts.http01Acme
 * @param {string} opts.webroot
 */
export function renderSiteVhost(opts) {
  const { site, http01Acme, webroot } = opts;
  const id = siteId(site);
  const names = serverNames(site);
  const listen = Array.isArray(site.listen)
    ? site.listen.map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0)
    : [80, 443];
  const upstream =
    typeof site.upstream === "string" && site.upstream.trim() ? site.upstream.trim() : "";
  const root = staticRoot(site);
  if (!upstream && !root) {
    throw new Error(`${id}: upstream or static.root required`);
  }
  if (upstream && root) {
    throw new Error(`${id}: specify upstream or static.root, not both`);
  }

  const tls = isObject(site.tls) ? site.tls : {};
  const tlsEnabled = tls.enabled !== false;
  const certName =
    typeof tls.cert_name === "string" && tls.cert_name.trim()
      ? tls.cert_name.trim()
      : names[0];

  const locations = Array.isArray(site.locations) ? site.locations.filter(isObject) : [];
  const locBlocks = root
    ? (locations.length > 0
        ? locations.map((loc) => renderStaticLocationBlock(loc, root, staticIndex(site)))
        : [renderStaticLocationBlock({ path: "/" }, root, staticIndex(site))])
    : locations.length > 0
      ? locations.map((loc) => renderProxyLocationBlock(loc, upstream))
      : [renderProxyLocationBlock({ path: "/", proxy_headers: true }, upstream)];

  /** @type {string[]} */
  const blocks = [];

  if (listen.includes(80)) {
    const acme =
      http01Acme && tlsEnabled
        ? `
    location ^~ /.well-known/acme-challenge/ {
        root ${webroot};
        default_type "text/plain";
    }`
        : "";
    if (tlsEnabled) {
      blocks.push(`server {
    listen 80;
    listen [::]:80;
    server_name ${names.join(" ")};
${acme}
    location / {
        return 301 https://$host$request_uri;
    }
}
`);
    } else {
      blocks.push(`server {
    listen 80;
    listen [::]:80;
    server_name ${names.join(" ")};
${root ? `    root ${root};\n    index ${staticIndex(site)};\n` : ""}${locBlocks.join("\n")}
}
`);
    }
  }

  if (listen.includes(443) && tlsEnabled) {
    blocks.push(`server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${names.join(" ")};
    ssl_certificate /etc/letsencrypt/live/${certName}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${certName}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
${root ? `    root ${root};\n    index ${staticIndex(site)};\n` : ""}${locBlocks.join("\n")}
}
`);
  } else if (!listen.includes(80)) {
    blocks.push(`server {
    listen ${listen[0]};
    server_name ${names.join(" ")};
${root ? `    root ${root};\n    index ${staticIndex(site)};\n` : ""}${locBlocks.join("\n")}
}
`);
  }

  return `# hdc site ${id}\n${blocks.join("\n")}`;
}

/**
 * @param {Record<string, unknown>} loc
 * @param {string} upstream
 */
function renderProxyLocationBlock(loc, upstream) {
  const path = typeof loc.path === "string" && loc.path.trim() ? loc.path.trim() : "/";
  const headers = loc.proxy_headers !== false;
  const headerLines = headers
    ? `
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;`
    : "";
  return `    location ${path} {
        proxy_pass ${upstream};${headerLines}
    }`;
}

/**
 * @param {Record<string, unknown>} loc
 * @param {string} root
 * @param {string} index
 */
function renderStaticLocationBlock(loc, root, index) {
  const path = typeof loc.path === "string" && loc.path.trim() ? loc.path.trim() : "/";
  if (path === "/") {
    return `    location / {
        try_files $uri $uri/ =404;
    }`;
  }
  return `    location ${path} {
        alias ${root}${path.endsWith("/") ? path : `${path}/`};
        try_files $uri $uri/ =404;
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
