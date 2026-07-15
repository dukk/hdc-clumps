import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { buildAllDnsChecklists, formatDnsChecklistMarkdown } from "./mailcow-dns.mjs";
import { createMailcowApiClient, getDkim, listAliases, listDomains, listMailboxes } from "./mailcow-api.mjs";
import { buildMailboxAliasDriftReport } from "./mailcow-mailboxes.mjs";
import {
  installDir,
  normalizeAliasList,
  normalizeDomainList,
  normalizeHostname,
  normalizeMailboxList,
  resolveAdminUrl,
  resolveApiBaseUrl,
} from "./mailcow-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {import("./mailcow-dns.mjs").MailcowDomainConfig[]} configuredDomains
 * @param {unknown[]} apiDomains
 */
function buildDomainDriftFields(configuredDomains, apiDomains) {
  const configuredNames = configuredDomains.map((d) => d.name);
  const liveNames = Array.isArray(apiDomains)
    ? apiDomains
        .map((d) => (isObject(d) && typeof d.domain_name === "string" ? d.domain_name.trim() : ""))
        .filter(Boolean)
    : [];
  const configuredSet = new Set(configuredNames);
  const liveSet = new Set(liveNames);
  return {
    configured_domains: configuredNames,
    live_domain_names: liveNames,
    missing_domains: configuredNames.filter((name) => !liveSet.has(name)),
    extra_domains: liveNames.filter((name) => !configuredSet.has(name)),
  };
}

/**
 * @param {Record<string, unknown>} mc
 * @param {string | null} apiKey
 */
async function queryMailcowApiState(mc, apiKey) {
  const configuredDomains = normalizeDomainList(mc);
  const configuredMailboxes = normalizeMailboxList(mc);
  const configuredAliases = normalizeAliasList(mc);
  /** @type {Record<string, { dkim_txt?: string | null; dkim_selector?: string | null }>} */
  const liveByDomain = {};
  /** @type {unknown[]} */
  let apiDomains = [];
  /** @type {unknown[]} */
  let apiMailboxes = [];
  /** @type {unknown[]} */
  let apiAliases = [];
  let apiOk = null;
  /** @type {string | null} */
  let apiError = null;

  if (apiKey) {
    try {
      const client = createMailcowApiClient(resolveApiBaseUrl(mc), apiKey);
      apiDomains = await listDomains(client);
      apiMailboxes = await listMailboxes(client);
      apiAliases = await listAliases(client);
      apiOk = true;
      for (const d of configuredDomains) {
        try {
          const dkim = await getDkim(client, d.name);
          liveByDomain[d.name] = {
            dkim_txt: isObject(dkim) && typeof dkim.dkim_txt === "string" ? dkim.dkim_txt : null,
            dkim_selector:
              isObject(dkim) && typeof dkim.dkim_selector === "string" ? dkim.dkim_selector : null,
          };
        } catch {
          liveByDomain[d.name] = { dkim_txt: null, dkim_selector: null };
        }
      }
    } catch (e) {
      apiOk = false;
      apiError = String(/** @type {Error} */ (e).message || e);
    }
  }

  const dnsChecklists = buildAllDnsChecklists(
    configuredDomains,
    normalizeHostname(mc),
    liveByDomain,
  );
  const drift = buildDomainDriftFields(configuredDomains, apiDomains);
  const mailboxAliasDrift = buildMailboxAliasDriftReport(
    configuredMailboxes,
    apiMailboxes,
    configuredAliases,
    apiAliases,
  );

  return {
    configuredDomains,
    configuredMailboxes,
    configuredAliases,
    liveByDomain,
    apiDomains,
    apiMailboxes,
    apiAliases,
    apiOk,
    apiError,
    dnsChecklists,
    drift,
    mailboxAliasDrift,
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {string | null} apiKey
 */
export async function queryMailcowOnHost(exec, mailcow, install, apiKey) {
  const mc = isObject(mailcow) ? mailcow : {};
  const dir = installDir(isObject(install) ? install : {});
  const hostname = normalizeHostname(mc);
  const adminUrl = resolveAdminUrl(mc);

  const docker = exec.run("systemctl is-active docker 2>/dev/null || echo inactive");
  const composePs = exec.run(
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
  );
  const ip = exec.run("hostname -I | awk '{print $1}'");
  const guestIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  let adminOk = null;
  let adminError = null;
  if (docker.stdout.trim() === "active") {
    const probeUrl = adminUrl || `https://${hostname}`;
    const healthCmd = `curl -skf --max-time 8 ${JSON.stringify(probeUrl)} -o /dev/null && echo ok || echo fail`;
    const h = exec.run(healthCmd);
    if (h.status === 0 && h.stdout.trim() === "ok") {
      adminOk = true;
    } else {
      adminOk = false;
      adminError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  const apiState = await queryMailcowApiState(mc, apiKey);

  return {
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    guest_ip: guestIp,
    ct_ip: guestIp,
    hostname,
    admin_url: adminUrl,
    admin_ok: adminOk,
    admin_error: adminError,
    api_ok: apiState.apiOk,
    api_error: apiState.apiError,
    api_domain_count: Array.isArray(apiState.apiDomains) ? apiState.apiDomains.length : 0,
    api_mailbox_count: Array.isArray(apiState.apiMailboxes) ? apiState.apiMailboxes.length : 0,
    api_alias_count: Array.isArray(apiState.apiAliases) ? apiState.apiAliases.length : 0,
    configured_domain_count: apiState.configuredDomains.length,
    configured_mailbox_count: apiState.configuredMailboxes.length,
    configured_alias_count: apiState.configuredAliases.length,
    ...apiState.drift,
    ...apiState.mailboxAliasDrift,
    dns_checklists: apiState.dnsChecklists,
    dns_checklist_markdown: apiState.dnsChecklists
      .map((c) => `### ${c.domain} (${c.outbound_mode})\n\n${formatDnsChecklistMarkdown(c.records)}`)
      .join("\n\n"),
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} mailcow
 * @param {Record<string, unknown>} install
 * @param {string | null} apiKey
 */
export async function queryMailcowInCt(user, pveHost, vmid, mailcow, install, apiKey) {
  const mc = isObject(mailcow) ? mailcow : {};
  const dir = installDir(isObject(install) ? install : {});
  const hostname = normalizeHostname(mc);
  const adminUrl = resolveAdminUrl(mc);

  const docker = pctExec(
    user,
    pveHost,
    vmid,
    "systemctl is-active docker 2>/dev/null || echo inactive",
    { capture: true },
  );
  const composePs = pctExec(
    user,
    pveHost,
    vmid,
    `test -d ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && docker compose ps --format json 2>/dev/null || docker compose ps 2>/dev/null || echo '[]'`,
    { capture: true },
  );
  const ip = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  const ctIp = ip.status === 0 ? ip.stdout.trim().split(/\s+/)[0] || null : null;

  let adminOk = null;
  let adminError = null;
  if (docker.stdout.trim() === "active") {
    const probeUrl = adminUrl || `https://${hostname}`;
    const healthCmd = `curl -skf --max-time 8 ${JSON.stringify(probeUrl)} -o /dev/null && echo ok || echo fail`;
    const h = pctExec(user, pveHost, vmid, healthCmd, { capture: true });
    if (h.status === 0 && h.stdout.trim() === "ok") {
      adminOk = true;
    } else {
      adminOk = false;
      adminError = h.stderr.trim() || h.stdout.trim() || `exit ${h.status}`;
    }
  }

  const apiState = await queryMailcowApiState(mc, apiKey);

  return {
    vmid,
    docker_active: docker.stdout.trim(),
    compose_ps: composePs.stdout.trim() || null,
    ct_ip: ctIp,
    hostname,
    admin_url: adminUrl,
    admin_ok: adminOk,
    admin_error: adminError,
    api_ok: apiState.apiOk,
    api_error: apiState.apiError,
    api_domain_count: Array.isArray(apiState.apiDomains) ? apiState.apiDomains.length : 0,
    api_mailbox_count: Array.isArray(apiState.apiMailboxes) ? apiState.apiMailboxes.length : 0,
    api_alias_count: Array.isArray(apiState.apiAliases) ? apiState.apiAliases.length : 0,
    configured_domain_count: apiState.configuredDomains.length,
    configured_mailbox_count: apiState.configuredMailboxes.length,
    configured_alias_count: apiState.configuredAliases.length,
    ...apiState.drift,
    ...apiState.mailboxAliasDrift,
    dns_checklists: apiState.dnsChecklists,
    dns_checklist_markdown: apiState.dnsChecklists
      .map((c) => `### ${c.domain} (${c.outbound_mode})\n\n${formatDnsChecklistMarkdown(c.records)}`)
      .join("\n\n"),
  };
}
