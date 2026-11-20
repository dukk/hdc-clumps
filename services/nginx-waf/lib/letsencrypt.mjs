import { renderCertbotDnsCredentials, hostNames } from "./nginx-waf-render.mjs";
import { resolveSiteAcmeSettings } from "./deployments.mjs";

const CERTBOT_DNS_CREDENTIALS = "/etc/letsencrypt/hdc-dns-rfc2136.ini";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Certificate obtain batches grouped by ACME server/challenge/staging.
 * @param {Record<string, unknown>[]} sites
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} groupGlobal
 */
export function tlsCertObtainPlans(sites, groupGlobal) {
  /** @type {Map<string, { acme: ReturnType<typeof resolveSiteAcmeSettings>, certName: string, sans: string[] }>} */
  const byCert = new Map();
  for (const site of sites) {
    const tls = isObject(site.tls) ? site.tls : {};
    if (tls.enabled === false) continue;
    const certName =
      typeof tls.cert_name === "string" && tls.cert_name.trim()
        ? tls.cert_name.trim()
        : hostNames(site)[0];
    const acme = resolveSiteAcmeSettings(site, groupGlobal.acme);
    const key = `${acme.provider}|${acme.server}|${acme.challenge}|${acme.staging}|${certName}`;
    let entry = byCert.get(key);
    if (!entry) {
      entry = { acme, certName, sans: [] };
      byCert.set(key, entry);
    }
    for (const name of hostNames(site)) {
      if (!entry.sans.includes(name)) entry.sans.push(name);
    }
  }
  return [...byCert.values()];
}

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
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
 * First meaningful line from a certbot/SSH error blob (skip known_hosts noise).
 * @param {string} msg
 */
export function firstMeaningfulErrorLine(msg) {
  const lines = String(msg)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^\s*Warning:\s*Permanently added/i.test(line)) continue;
    if (/^\s*#\s*hdc\b/i.test(line)) continue;
    return line;
  }
  return lines[0] || String(msg).trim() || "unknown error";
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} remotePath
 * @param {string} content
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function uploadFile(exec, remotePath, content, log) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`, log);
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} domain
 */
export function certExistsOnHost(exec, domain) {
  const safe = String(domain).replace(/[^a-zA-Z0-9._-]/g, "");
  const r = exec.run(`test -f /etc/letsencrypt/live/${safe}/fullchain.pem`, { capture: true });
  return r.status === 0;
}

/**
 * Parse openssl `x509 -ext subjectAltName` (or similar) output into DNS names.
 * @param {string} text
 * @returns {string[]}
 */
export function parseCertSanOutput(text) {
  /** @type {string[]} */
  const names = [];
  for (const m of String(text).matchAll(/DNS:([^\s,]+)/gi)) {
    const n = m[1].trim().toLowerCase();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

/**
 * Read DNS SANs from a live Let's Encrypt cert on the host.
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} certName
 * @returns {string[] | null} null when the cert file is missing or unreadable
 */
export function readCertSansOnHost(exec, certName) {
  const safe = String(certName).replace(/[^a-zA-Z0-9._-]/g, "");
  const path = `/etc/letsencrypt/live/${safe}/fullchain.pem`;
  const r = exec.run(
    `test -f ${shellQuote(path)} && openssl x509 -noout -ext subjectAltName -in ${shellQuote(path)}`,
    { capture: true },
  );
  if (r.status !== 0) return null;
  return parseCertSanOutput(`${r.stdout}\n${r.stderr}`);
}

/**
 * Desired hostnames not present in live SANs (case-insensitive).
 * @param {string[]} desired
 * @param {string[]} live
 * @returns {string[]}
 */
export function sansMissingFromLive(desired, live) {
  const liveSet = new Set(live.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  /** @type {string[]} */
  const missing = [];
  for (const raw of desired) {
    const n = String(raw).trim().toLowerCase();
    if (!n || liveSet.has(n) || missing.includes(n)) continue;
    missing.push(n);
  }
  return missing;
}

/**
 * Live SANs that are no longer configured (e.g. a name moved to its own lineage).
 * @param {string[]} desired
 * @param {string[]} live
 */
export function sansExtraInLive(desired, live) {
  const want = new Set(desired.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  return [...new Set(live.map((n) => String(n).trim().toLowerCase()).filter(Boolean))].filter((n) => !want.has(n));
}

/**
 * True when the cert is missing or live SANs differ from the configured names.
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} certName
 * @param {string[]} sans
 */
export function certNeedsEnsureOnHost(exec, certName, sans) {
  if (!certExistsOnHost(exec, certName)) return true;
  const desired = sans.length ? sans : [certName];
  const live = readCertSansOnHost(exec, certName);
  if (live === null) return true;
  return sansMissingFromLive(desired, live).length > 0 || sansExtraInLive(desired, live).length > 0;
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").parseAcmeSettings>} acme
 */
function acmeServerFlag(acme) {
  if (acme.provider === "custom" && acme.server) {
    return ` --server ${shellQuote(acme.server)}`;
  }
  if (acme.staging) {
    return " --staging";
  }
  return "";
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").parseAcmeSettings>} acme
 */
function acmeCaBundlePrefix(acme) {
  if (acme.provider === "custom" && acme.rootCaPath) {
    return `REQUESTS_CA_BUNDLE=${shellQuote(acme.rootCaPath)} `;
  }
  return "";
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").parseAcmeSettings>} opts.acme
 * @param {string} [opts.tsigSecret]
 */
/**
 * Path of the RFC2136 credentials file for a zone. The group default zone keeps the historic
 * path (`CERTBOT_DNS_CREDENTIALS`) so existing renewal confs keep working; any other zone gets
 * `/etc/letsencrypt/hdc-dns-rfc2136-<zone>.ini`.
 * @param {string} zone
 * @param {string} [defaultZone]
 */
export function certbotDnsCredentialsPath(zone, defaultZone) {
  const z = String(zone || "").trim().toLowerCase().replace(/\.$/, "");
  const d = String(defaultZone || "").trim().toLowerCase().replace(/\.$/, "");
  if (!z) return CERTBOT_DNS_CREDENTIALS;
  if (!d || z === d) return CERTBOT_DNS_CREDENTIALS;
  if (!/^[a-z0-9.-]+$/.test(z)) throw new Error(`invalid dns zone ${JSON.stringify(zone)}`);
  return `/etc/letsencrypt/hdc-dns-rfc2136-${z}.ini`;
}

export function ensureAcmeDnsCredentials(opts) {
  const { exec, log, acme, tsigSecret, defaultDnsZone } = opts;
  if (acme.challenge !== "dns-01") return;
  if (!acme.dnsZone || !acme.dnsNameservers.length) {
    throw new Error("dns-01 requires acme.dns.zone and dns.nameservers");
  }
  if (!tsigSecret) throw new Error("dns-01 requires TSIG secret from vault");
  const creds = renderCertbotDnsCredentials({
    dnsZone: acme.dnsZone,
    dnsNameserver: acme.dnsNameservers[0],
    keyName: acme.dnsKeyName,
    tsigSecret,
  });
  const path = certbotDnsCredentialsPath(acme.dnsZone, defaultDnsZone ?? acme.dnsZone);
  uploadFile(exec, path, creds, log);
  runChecked(exec, `chmod 600 ${shellQuote(path)}`, log);
  return path;
}

/**
 * Write RFC2136 credential files for every zone used by the group's sites (and the group default),
 * then point existing dns-rfc2136 renewal confs at the file for that lineage's zone.
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {{ info: Function }} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} opts.global
 * @param {string} opts.tsigSecret
 */
export function ensureAllAcmeDnsCredentials(opts) {
  const { exec, log, global, tsigSecret } = opts;
  if (!tsigSecret || !global?.dnsZone || !global.dnsNameservers?.length) return { zones: [], retargeted: [] };
  const plans = tlsCertObtainPlans(global.sites || [], global);
  /** @type {Map<string, string>} certName -> zone */
  const certZone = new Map();
  const zones = new Set([global.dnsZone]);
  for (const plan of plans) {
    if (plan.acme.challenge !== "dns-01" || !plan.acme.dnsZone) continue;
    zones.add(plan.acme.dnsZone);
    certZone.set(plan.certName, plan.acme.dnsZone);
    for (const n of plan.sans) certZone.set(n, plan.acme.dnsZone);
  }
  for (const zone of zones) {
    ensureAcmeDnsCredentials({
      exec,
      log,
      acme: { ...global.acme, challenge: "dns-01", dnsZone: zone, dnsNameservers: global.dnsNameservers, dnsKeyName: global.dnsKeyName },
      tsigSecret,
      defaultDnsZone: global.dnsZone,
    });
  }
  /** @type {string[]} */
  const retargeted = [];
  for (const [certName, zone] of certZone) {
    const path = certbotDnsCredentialsPath(zone, global.dnsZone);
    if (path === CERTBOT_DNS_CREDENTIALS) continue;
    const conf = `/etc/letsencrypt/renewal/${certName}.conf`;
    const r = exec.run(
      `test -f ${shellQuote(conf)} && grep -q '^authenticator = dns-rfc2136' ${shellQuote(conf)} && ` +
        `grep -q '^dns_rfc2136_credentials = ' ${shellQuote(conf)} && ` +
        `sed -i ${shellQuote(`s|^dns_rfc2136_credentials = .*|dns_rfc2136_credentials = ${path}|`)} ${shellQuote(conf)}`,
      { capture: true },
    );
    if (r.status === 0) retargeted.push(certName);
  }
  if (retargeted.length) log.info(`retargeted dns-rfc2136 credentials for ${retargeted.join(", ")}`);
  return { zones: [...zones], retargeted };
}

/** @deprecated Use ensureAcmeDnsCredentials */
export function ensureLetsencryptDnsCredentials(opts) {
  const global = opts.global;
  const acme =
    global && typeof global === "object" && global.acme
      ? global.acme
      : global;
  return ensureAcmeDnsCredentials({
    exec: opts.exec,
    log: opts.log,
    acme,
    tsigSecret: opts.tsigSecret,
  });
}

/**
 * Build certbot certonly command for a TLS obtain plan.
 * @param {object} opts
 * @param {ReturnType<typeof import("./deployments.mjs").parseAcmeSettings>} opts.acme
 * @param {string} opts.email
 * @param {string} opts.certName
 * @param {string[]} opts.sans
 */
export function buildCertonlyCommand(opts) {
  const { acme, email, certName, sans, replaceLineage = false, defaultDnsZone } = opts;
  const agree = " --agree-tos --non-interactive";
  const domainFlags = (sans.length ? sans : [certName]).map((n) => `-d ${n}`).join(" ");
  // --expand adds names; omitting it and passing --force-renewal replaces the lineage's exact SAN set.
  const certFlags = ` --cert-name ${shellQuote(certName)}` + (replaceLineage ? " --force-renewal" : " --expand");
  const serverFlag = acmeServerFlag(acme);
  const caBundle = acmeCaBundlePrefix(acme);
  if (acme.challenge === "dns-01") {
    const creds = certbotDnsCredentialsPath(acme.dnsZone, defaultDnsZone ?? acme.dnsZone);
    return (
      `${caBundle}certbot certonly --dns-rfc2136 --dns-rfc2136-credentials ${shellQuote(creds)} ` +
      `--email ${shellQuote(email)}${agree}${certFlags}${serverFlag} ${domainFlags}`
    );
  }
  return (
    `${caBundle}mkdir -p ${shellQuote(acme.webroot || "/var/www/letsencrypt")} && certbot certonly --webroot -w ${shellQuote(acme.webroot || "/var/www/letsencrypt")} ` +
    `--email ${shellQuote(email)}${agree}${certFlags}${serverFlag} ${domainFlags}`
  );
}

/**
 * Whether a hostname is in (or equal to) an authoritative DNS zone name.
 * @param {string} name
 * @param {string} zone
 */
export function acmeNameInDnsZone(name, zone) {
  const n = String(name).trim().toLowerCase().replace(/\.$/, "");
  const z = String(zone).trim().toLowerCase().replace(/\.$/, "");
  if (!n || !z) return false;
  return n === z || n.endsWith(`.${z}`);
}

/**
 * True when every name in the list is covered by zone (for BIND RFC2136 dns-01).
 * @param {string[]} names
 * @param {string} zone
 */
export function acmeNamesCoveredByZone(names, zone) {
  const list = names.map((n) => String(n).trim()).filter(Boolean);
  if (!list.length || !zone) return false;
  return list.every((name) => acmeNameInDnsZone(name, zone));
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").parseAcmeSettings>} acme
 * @param {string} [tsigSecret]
 * @param {string[]} sans
 * @param {string} certName
 */
function canDnsFallback(acme, tsigSecret, sans, certName) {
  if (!acme.dnsZone || !acme.dnsNameservers?.length || !tsigSecret) return false;
  const names = sans.length ? sans : [certName];
  return acmeNamesCoveredByZone(names, acme.dnsZone);
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").parseAcmeSettings>} opts.acme
 * @param {string} opts.email
 * @param {string} opts.certName
 * @param {string[]} opts.sans
 * @param {string} [opts.tsigSecret]
 */
function obtainCertificateWithChallenge(opts) {
  const { exec, log, acme, email, certName, sans, tsigSecret, replaceLineage = false, defaultDnsZone } = opts;
  if (acme.challenge === "dns-01") {
    ensureAcmeDnsCredentials({ exec, log, acme, tsigSecret, defaultDnsZone });
  }
  runChecked(exec, buildCertonlyCommand({ acme, email, certName, sans, replaceLineage, defaultDnsZone }), log);
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} opts.global
 * @param {string} opts.email
 * @param {Record<string, unknown>[]} opts.sites
 * @param {string} [opts.tsigSecret]
 */
/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").parseAcmeSettings>} opts.acme
 * @param {string} opts.email
 * @param {string} opts.certName
 * @param {string[]} opts.sans
 * @param {string} [opts.tsigSecret]
 * @returns {boolean} true when a certificate was written
 */
function tryObtainOrExpandCertificate(opts) {
  const { exec, log, acme, email, certName, sans, tsigSecret, replaceLineage = false, defaultDnsZone } = opts;
  const names = sans.length ? sans : [certName];
  try {
    obtainCertificateWithChallenge({ exec, log, acme, email, certName, sans, tsigSecret, replaceLineage, defaultDnsZone });
    return true;
  } catch (httpErr) {
    const msg = String(/** @type {Error} */ (httpErr).message || httpErr);
    const short = firstMeaningfulErrorLine(msg);
    if (acme.challenge !== "http-01" || !canDnsFallback(acme, tsigSecret, sans, certName)) {
      if (
        acme.challenge === "http-01" &&
        acme.dnsZone &&
        tsigSecret &&
        !acmeNamesCoveredByZone(names, acme.dnsZone)
      ) {
        log.info(
          `certificate obtain failed for ${certName}: ${short} (dns-01 fallback skipped: cert names not in BIND zone ${acme.dnsZone})`,
        );
      } else {
        log.info(`certificate obtain failed for ${certName}: ${short}`);
      }
      return false;
    }
    log.info(`http-01 failed for ${certName}, retrying dns-01`);
    try {
      const dnsAcme = { ...acme, challenge: "dns-01" };
      obtainCertificateWithChallenge({
        exec,
        log,
        acme: dnsAcme,
        email,
        certName,
        sans,
        tsigSecret,
        replaceLineage,
        defaultDnsZone,
      });
      return true;
    } catch (dnsErr) {
      const dnsMsg = String(/** @type {Error} */ (dnsErr).message || dnsErr);
      log.info(`certificate obtain failed for ${certName}: ${firstMeaningfulErrorLine(dnsMsg)}`);
      return false;
    }
  }
}

/**
 * Obtain missing certs and expand existing certs when configured SANs are incomplete.
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} opts.global
 * @param {string} opts.email
 * @param {Record<string, unknown>[]} opts.sites
 * @param {string} [opts.tsigSecret]
 */
export function obtainMissingCertificates(opts) {
  const { exec, log, global, email, sites, tsigSecret } = opts;
  const defaultDnsZone = global.dnsZone || "";
  const plans = tlsCertObtainPlans(sites, global);
  if (!plans.length) {
    log.info("no TLS domains configured");
    return { obtained: [], expanded: [], skipped: [] };
  }
  if (!email) throw new Error("ACME account email required (config or vault)");

  /** @type {string[]} */
  const obtained = [];
  /** @type {string[]} */
  const expanded = [];
  /** @type {string[]} */
  const skipped = [];

  for (const plan of plans) {
    const { certName, sans, acme } = plan;
    const desired = sans.length ? sans : [certName];
    const exists = certExistsOnHost(exec, certName);
    if (exists) {
      const live = readCertSansOnHost(exec, certName) ?? [];
      const missing = sansMissingFromLive(desired, live);
      const extra = sansExtraInLive(desired, live);
      if (!missing.length && !extra.length) {
        skipped.push(certName);
        continue;
      }
      if (missing.length) log.info(`expanding certificate ${certName}: adding ${missing.join(", ")}`);
      // Reissue with the exact configured set (certbot --cert-name replaces the lineage's names).
      if (extra.length) log.info(`reissuing certificate ${certName}: removing ${extra.join(", ")}`);
      if (tryObtainOrExpandCertificate({
        exec, log, acme, email, certName, sans, tsigSecret,
        replaceLineage: extra.length > 0,
        defaultDnsZone,
      })) {
        expanded.push(certName);
      }
      continue;
    }
    if (tryObtainOrExpandCertificate({ exec, log, acme, email, certName, sans, tsigSecret, defaultDnsZone })) {
      obtained.push(certName);
    }
  }
  return { obtained, expanded, skipped };
}

/**
 * Whether any site cert on the host is missing or needs SAN expansion.
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>[]} sites
 * @param {ReturnType<typeof import("./deployments.mjs").nginxWafGroupSettings>} groupGlobal
 */
export function anyCertNeedsEnsureOnHost(exec, sites, groupGlobal) {
  for (const plan of tlsCertObtainPlans(sites, groupGlobal)) {
    if (certNeedsEnsureOnHost(exec, plan.certName, plan.sans)) return true;
  }
  return false;
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 */
export function renewCertificates(opts) {
  const { exec, log } = opts;
  runChecked(exec, "certbot renew --non-interactive", log);
  log.info("certbot renew finished");
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} certName
 */
export function queryCertExpiry(exec, certName) {
  const path = `/etc/letsencrypt/live/${certName}/fullchain.pem`;
  const r = exec.run(
    `test -f ${shellQuote(path)} && openssl x509 -enddate -noout -in ${shellQuote(path)}`,
    { capture: true },
  );
  if (r.status !== 0) {
    return { cert_name: certName, present: false, enddate: null };
  }
  const line = r.stdout.trim();
  const enddate = line.startsWith("notAfter=") ? line.slice("notAfter=".length) : line;
  return { cert_name: certName, present: true, enddate };
}
