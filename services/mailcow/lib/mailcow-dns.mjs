/**
 * @typedef {object} MailcowDomainDnsConfig
 * @property {number} mx_priority
 * @property {string} spf
 * @property {string} dmarc
 * @property {string} notes
 */

/**
 * @typedef {object} MailcowDomainConfig
 * @property {string} name
 * @property {string} description
 * @property {string} dkim_selector
 * @property {1024 | 2048} dkim_key_size
 * @property {"direct" | "postfix-relay"} outbound_mode
 * @property {MailcowDomainDnsConfig} dns
 */

/**
 * @typedef {object} DnsChecklistRecord
 * @property {string} type
 * @property {string} name
 * @property {string} data
 * @property {number} [priority]
 * @property {string} [purpose]
 */

/**
 * @param {string} domain
 * @param {string} selector
 */
export function dkimOwnerName(domain, selector) {
  return `${selector}._domainkey.${domain}`;
}

/**
 * @param {MailcowDomainConfig} domain
 * @param {string} mailcowHostname MAILCOW_HOSTNAME FQDN (MX target)
 * @param {{ dkim_txt?: string | null; dkim_selector?: string | null }} [live]
 * @returns {DnsChecklistRecord[]}
 */
export function buildDnsChecklist(domain, mailcowHostname, live = {}) {
  const mxHost = mailcowHostname.endsWith(".") ? mailcowHostname : `${mailcowHostname}.`;
  const selector = live.dkim_selector || domain.dkim_selector || "dkim";
  const dkimName = dkimOwnerName(domain.name, selector);
  const dkimData =
    live.dkim_txt && live.dkim_txt.trim()
      ? live.dkim_txt.trim()
      : "{{dkim_txt}} — run maintain after API key is set";

  /** @type {DnsChecklistRecord[]} */
  const records = [
    {
      type: "MX",
      name: domain.name,
      data: mxHost,
      priority: domain.dns.mx_priority ?? 10,
      purpose: "Inbound mail to mailcow",
    },
  ];

  if (domain.dns.spf) {
    records.push({
      type: "TXT",
      name: domain.name,
      data: domain.dns.spf,
      purpose:
        domain.outbound_mode === "postfix-relay"
          ? "SPF (outbound via postfix-relay / provider)"
          : "SPF (direct outbound from mailcow)",
    });
  }

  records.push({
    type: "TXT",
    name: dkimName,
    data: dkimData,
    purpose: "DKIM signing (Mailcow)",
  });

  if (domain.dns.dmarc) {
    records.push({
      type: "TXT",
      name: `_dmarc.${domain.name}`,
      data: domain.dns.dmarc,
      purpose: "DMARC policy",
    });
  }

  records.push({
    type: "CNAME",
    name: `autodiscover.${domain.name}`,
    data: mailcowHostname,
    purpose: "Optional autodiscover (SOGo/Outlook)",
  });

  return records;
}

/**
 * @param {DnsChecklistRecord[]} records
 * @returns {string}
 */
export function formatDnsChecklistMarkdown(records) {
  const lines = ["| Type | Name | Data | Notes |", "| --- | --- | --- | --- |"];
  for (const r of records) {
    const data =
      r.type === "MX" && r.priority !== undefined
        ? `${r.priority} ${r.data}`
        : r.data;
    const notes = [r.purpose].filter(Boolean).join("; ");
    lines.push(`| ${r.type} | ${r.name} | ${data.replace(/\|/g, "\\|")} | ${notes} |`);
  }
  return lines.join("\n");
}

/**
 * @param {MailcowDomainConfig[]} domains
 * @param {string} mailcowHostname
 * @param {Record<string, { dkim_txt?: string | null; dkim_selector?: string | null }>} [liveByDomain]
 */
export function buildAllDnsChecklists(domains, mailcowHostname, liveByDomain = {}) {
  return domains.map((d) => ({
    domain: d.name,
    outbound_mode: d.outbound_mode,
    notes: d.dns.notes || null,
    records: buildDnsChecklist(d, mailcowHostname, liveByDomain[d.name] ?? {}),
  }));
}
