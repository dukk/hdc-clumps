import { renderCertbotDnsCredentials, tlsDomainsFromSites } from "./nginx-render.mjs";

const CERTBOT_DNS_CREDENTIALS = "/etc/letsencrypt/hdc-dns-rfc2136.ini";

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
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxGlobalSettings>} opts.global
 * @param {string} [opts.tsigSecret]
 */
export function ensureLetsencryptDnsCredentials(opts) {
  const { exec, log, global, tsigSecret } = opts;
  if (global.challenge !== "dns-01") return;
  if (!global.dnsZone || !global.dnsNameservers.length) {
    throw new Error("dns-01 requires letsencrypt.dns.zone and dns.nameservers");
  }
  if (!tsigSecret) throw new Error("dns-01 requires TSIG secret from vault");
  const creds = renderCertbotDnsCredentials({
    dnsZone: global.dnsZone,
    dnsNameserver: global.dnsNameservers[0],
    keyName: global.dnsKeyName,
    tsigSecret,
  });
  uploadFile(exec, CERTBOT_DNS_CREDENTIALS, creds, log);
  runChecked(exec, `chmod 600 ${shellQuote(CERTBOT_DNS_CREDENTIALS)}`, log);
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxGlobalSettings>} opts.global
 * @param {string} opts.email
 * @param {Record<string, unknown>[]} opts.sites
 * @param {string} [opts.tsigSecret]
 */
export function obtainMissingCertificates(opts) {
  const { exec, log, global, email, sites, tsigSecret } = opts;
  const domains = tlsDomainsFromSites(sites);
  if (!domains.length) {
    log.info("no TLS domains configured");
    return { obtained: [], skipped: [] };
  }
  if (!email) throw new Error("Let's Encrypt email required (config or vault)");

  const stagingFlag = global.staging ? " --staging" : "";
  const agree = " --agree-tos --non-interactive";
  /** @type {string[]} */
  const obtained = [];
  /** @type {string[]} */
  const skipped = [];

  for (const domain of domains) {
    if (certExistsOnHost(exec, domain)) {
      skipped.push(domain);
      continue;
    }
    const domainFlags = `-d ${domain}`;
    if (global.challenge === "dns-01") {
      ensureLetsencryptDnsCredentials({ exec, log, global, tsigSecret });
      runChecked(
        exec,
        `certbot certonly --dns-rfc2136 --dns-rfc2136-credentials ${shellQuote(CERTBOT_DNS_CREDENTIALS)} ` +
          `--email ${shellQuote(email)}${agree}${stagingFlag} ${domainFlags}`,
        log,
      );
    } else {
      runChecked(
        exec,
        `mkdir -p ${shellQuote(global.webroot)} && certbot certonly --webroot -w ${shellQuote(global.webroot)} ` +
          `--email ${shellQuote(email)}${agree}${stagingFlag} ${domainFlags}`,
        log,
      );
    }
    obtained.push(domain);
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
