import { certExistsOnHost } from "./letsencrypt.mjs";
import { hostNames, parseUpstream, siteId } from "./nginx-waf-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} content
 * @param {string} fileSiteId
 */
export function parseLiveSiteVhost(content, fileSiteId) {
  /** @type {string[]} */
  const hostNamesList = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const m = trimmed.match(/^server_name\s+(.+?)\s*;/);
    if (m) {
      for (const name of m[1].split(/\s+/)) {
        const n = name.trim();
        if (n && n !== "_") hostNamesList.push(n);
      }
    }
  }
  const hasListen443 = /\blisten\s+(?:\[::\]:)?443\b/.test(content);
  const upstreamMatch = content.match(/location\s+\/\s*\{[\s\S]*?proxy_pass\s+(\S+)\s*;/);
  const rootUpstream = upstreamMatch ? upstreamMatch[1].replace(/;$/, "") : null;
  if (!rootUpstream) {
    const anyPass = content.match(/proxy_pass\s+(\S+)\s*;/);
    if (anyPass) {
      return {
        file_site_id: fileSiteId,
        host_names: hostNamesList,
        has_listen_443: hasListen443,
        upstream: anyPass[1].replace(/;$/, ""),
      };
    }
  }
  return {
    file_site_id: fileSiteId,
    host_names: hostNamesList,
    has_listen_443: hasListen443,
    upstream: rootUpstream,
  };
}

/**
 * @param {Record<string, unknown>} site
 */
function expectedUpstreamFromSite(site) {
  const id = siteId(site);
  if (typeof site.upstream === "string" && site.upstream.trim()) {
    return site.upstream.trim();
  }
  if (isObject(site.upstream)) {
    const parsed = parseUpstream(site.upstream, id);
    if (parsed.type === "direct") return parsed.proxyPass;
    const blockName = `hdc_${id.replace(/-/g, "_")}`;
    const scheme = parsed.scheme === "https" ? "https" : "http";
    return `${scheme}://${blockName}`;
  }
  return "";
}

/**
 * @param {Record<string, unknown>[]} sites
 */
export function expectedSiteMapFromConfig(sites) {
  /** @type {Map<string, { site_id: string; upstream: string; tls_enabled: boolean; cert_name: string | null }>} */
  const hostnameOwner = new Map();
  /** @type {Map<string, { upstream: string; host_names: string[]; tls_enabled: boolean; cert_name: string | null }>} */
  const bySiteId = new Map();

  for (const site of sites) {
    const id = siteId(site);
    const upstream = expectedUpstreamFromSite(site);
    const tls = isObject(site.tls) ? site.tls : {};
    const tlsEnabled = tls.enabled !== false;
    const certName =
      typeof tls.cert_name === "string" && tls.cert_name.trim()
        ? tls.cert_name.trim()
        : hostNames(site)[0] ?? null;
    const names = hostNames(site);
    bySiteId.set(id, { upstream, host_names: names, tls_enabled: tlsEnabled, cert_name: certName });
    for (const name of names) {
      hostnameOwner.set(name, { site_id: id, upstream, tls_enabled: tlsEnabled, cert_name: certName });
    }
  }
  return { hostnameOwner, bySiteId };
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>[]} opts.configSites
 * @param {ReturnType<typeof parseLiveSiteVhost>[]} opts.liveSites
 * @param {(certName: string) => boolean} [opts.certPresent]
 */
export function detectVhostDrift(opts) {
  const { configSites, liveSites, certPresent = () => false } = opts;
  const { hostnameOwner, bySiteId } = expectedSiteMapFromConfig(configSites);
  /** @type {Record<string, unknown>[]} */
  const drift = [];

  const liveById = new Map(liveSites.map((s) => [s.file_site_id, s]));
  for (const [id, expected] of bySiteId) {
    const live = liveById.get(id);
    if (!live) {
      drift.push({
        kind: "missing_site",
        site_id: id,
        message: `config site ${JSON.stringify(id)} has no hdc-${id}.conf on host`,
      });
      continue;
    }
    if (expected.upstream && live.upstream && live.upstream !== expected.upstream) {
      drift.push({
        kind: "upstream_mismatch",
        site_id: id,
        expected_upstream: expected.upstream,
        live_upstream: live.upstream,
        message: `${id}: upstream ${live.upstream} != config ${expected.upstream}`,
      });
    }
    if (expected.tls_enabled && expected.cert_name && certPresent(expected.cert_name) && !live.has_listen_443) {
      drift.push({
        kind: "https_missing",
        site_id: id,
        cert_name: expected.cert_name,
        message: `${id}: TLS cert present but vhost has no listen 443`,
      });
    }
    for (const name of live.host_names) {
      const owner = hostnameOwner.get(name);
      if (!owner || owner.site_id !== id) {
        drift.push({
          kind: "orphan_hostname",
          site_id: id,
          hostname: name,
          expected_site_id: owner?.site_id ?? null,
          message: owner
            ? `${name} on live ${id} belongs to config site ${owner.site_id}`
            : `${name} on live ${id} is not in nginx-waf config`,
        });
      }
    }
  }

  for (const live of liveSites) {
    if (live.file_site_id === "default") continue;
    if (!bySiteId.has(live.file_site_id)) {
      drift.push({
        kind: "extra_site",
        site_id: live.file_site_id,
        host_names: live.host_names,
        message: `live hdc-${live.file_site_id}.conf is not in config (run full maintain --prune to remove)`,
      });
    }
  }

  return drift;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>[]} configSites
 */
export function queryLiveVhostDrift(exec, configSites) {
  const list = exec.run("ls -1 /etc/nginx/sites-enabled/hdc-*.conf 2>/dev/null || true", {
    capture: true,
  });
  const paths = list.stdout.trim().split("\n").filter(Boolean);
  /** @type {ReturnType<typeof parseLiveSiteVhost>[]} */
  const liveSites = [];
  for (const path of paths) {
    const base = path.split("/").pop() ?? "";
    const m = base.match(/^hdc-([^.]+)\.conf$/);
    if (!m) continue;
    const read = exec.run(`cat ${shellQuote(path)} 2>/dev/null || true`, { capture: true });
    if (!read.stdout.trim()) continue;
    liveSites.push(parseLiveSiteVhost(read.stdout, m[1]));
  }
  const drift = detectVhostDrift({
    configSites,
    liveSites,
    certPresent: (certName) => certExistsOnHost(exec, certName),
  });
  return { live_sites: liveSites, vhost_drift: drift, ok: drift.length === 0 };
}

/** @deprecated Use host_names in drift output */
export const server_names = "host_names";
