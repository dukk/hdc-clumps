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
export function ensureAcmeDnsCredentials(opts) {
  const { exec, log, acme, tsigSecret } = opts;
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
  uploadFile(exec, CERTBOT_DNS_CREDENTIALS, creds, log);
  runChecked(exec, `chmod 600 ${shellQuote(CERTBOT_DNS_CREDENTIALS)}`, log);
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
  const { acme, email, certName, sans } = opts;
  const agree = " --agree-tos --non-interactive";
  const domainFlags = (sans.length ? sans : [certName]).map((n) => `-d ${n}`).join(" ");
  const serverFlag = acmeServerFlag(acme);
  const caBundle = acmeCaBundlePrefix(acme);
  if (acme.challenge === "dns-01") {
    return (
      `${caBundle}certbot certonly --dns-rfc2136 --dns-rfc2136-credentials ${shellQuote(CERTBOT_DNS_CREDENTIALS)} ` +
      `--email ${shellQuote(email)}${agree}${serverFlag} ${domainFlags}`
    );
  }
  return (
    `${caBundle}mkdir -p ${shellQuote(acme.webroot || "/var/www/letsencrypt")} && certbot certonly --webroot -w ${shellQuote(acme.webroot || "/var/www/letsencrypt")} ` +
    `--email ${shellQuote(email)}${agree}${serverFlag} ${domainFlags}`
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
  const { exec, log, acme, email, certName, sans, tsigSecret } = opts;
  if (acme.challenge === "dns-01") {
    ensureAcmeDnsCredentials({ exec, log, acme, tsigSecret });
  }
  runChecked(exec, buildCertonlyCommand({ acme, email, certName, sans }), log);
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
export function obtainMissingCertificates(opts) {
  const { exec, log, global, email, sites, tsigSecret } = opts;
  const plans = tlsCertObtainPlans(sites, global);
  if (!plans.length) {
    log.info("no TLS domains configured");
    return { obtained: [], skipped: [] };
  }
  if (!email) throw new Error("ACME account email required (config or vault)");

  /** @type {string[]} */
  const obtained = [];
  /** @type {string[]} */
  const skipped = [];

  for (const plan of plans) {
    const { certName, sans, acme } = plan;
    if (certExistsOnHost(exec, certName)) {
      skipped.push(certName);
      continue;
    }
    try {
      obtainCertificateWithChallenge({ exec, log, acme, email, certName, sans, tsigSecret });
      obtained.push(certName);
    } catch (httpErr) {
      const msg = String(/** @type {Error} */ (httpErr).message || httpErr);
      const names = sans.length ? sans : [certName];
      if (acme.challenge !== "http-01" || !canDnsFallback(acme, tsigSecret, sans, certName)) {
        if (
          acme.challenge === "http-01" &&
          acme.dnsZone &&
          tsigSecret &&
          !acmeNamesCoveredByZone(names, acme.dnsZone)
        ) {
          log.info(
            `certificate obtain failed for ${certName}: ${msg.split("\n")[0]} (dns-01 fallback skipped: cert names not in BIND zone ${acme.dnsZone})`,
          );
        } else {
          log.info(`certificate obtain failed for ${certName}: ${msg.split("\n")[0]}`);
        }
        continue;
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
        });
        obtained.push(certName);
      } catch (dnsErr) {
        const dnsMsg = String(/** @type {Error} */ (dnsErr).message || dnsErr);
        log.info(`certificate obtain failed for ${certName}: ${dnsMsg.split("\n")[0]}`);
      }
    }
  }
  return { obtained, skipped };
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
