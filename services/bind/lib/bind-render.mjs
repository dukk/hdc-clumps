/** @typedef {"primary" | "secondary"} BindRole */

export const TSIG_KEY_NAME = "hdc-bind-xfer";

/**
 * @param {string} name
 */
function zoneFileName(name) {
  return name.replace(/\./g, "_");
}

/**
 * Zone-file owner column: relative to apex (@ or label), never FQDN under the zone.
 * BIND appends the zone origin to dotted owners without a trailing dot, so
 * `pve-b.home.example.invalid` in zone hdc.example.invalid becomes pve-b.home.example.invalid.home.example.invalid.
 * @param {string} name
 * @param {string} zone Apex zone name.
 */
function zoneOwnerLabel(name, zone) {
  if (name === "@" || name === "") return "@";
  let n = name.endsWith(".") ? name.slice(0, -1) : name;
  if (n === zone) return "@";
  const suffix = `.${zone}`;
  if (n.endsWith(suffix)) n = n.slice(0, -suffix.length);
  return n;
}

/**
 * @param {object} opts
 * @param {string} opts.zone
 * @param {string} opts.serial
 * @param {string} opts.primaryNs FQDN with trailing dot.
 * @param {string} opts.hostmaster e.g. hostmaster.hdc.example.invalid.
 * @param {number} [opts.ttl]
 */
export function renderSoaLine(opts) {
  const ttl = opts.ttl ?? 3600;
  const ns = opts.primaryNs.endsWith(".") ? opts.primaryNs : `${opts.primaryNs}.`;
  const hm = opts.hostmaster.includes(".") ? opts.hostmaster : `${opts.hostmaster}.${opts.zone}`;
  const hostmaster = hm.includes("@") ? hm.replace("@", ".") : hm;
  const rname = hostmaster.endsWith(".") ? hostmaster : `${hostmaster}.`;
  return `@\t${ttl}\tIN\tSOA\t${ns}\t${rname} (\n\t\t\t${opts.serial}\t; serial\n\t\t\t3600\t; refresh\n\t\t\t1800\t; retry\n\t\t\t604800\t; expire\n\t\t\t86400 )\t; minimum\n`;
}

/**
 * @param {{ type: string; name: string; data: string; ttl: number }[]} records
 * @param {string} zone
 */
/**
 * @param {{ type: string; data: string }} rec
 */
function formatZoneRdata(rec) {
  const type = rec.type.toUpperCase();
  if (type === "A" || type === "AAAA" || type === "TXT" || type === "MX") {
    return rec.data;
  }
  return rec.data.endsWith(".") ? rec.data : `${rec.data}.`;
}

export function renderZoneRecords(records, zone) {
  const lines = [];
  for (const rec of records) {
    const owner = zoneOwnerLabel(rec.name, zone);
    lines.push(`${owner}\t${rec.ttl}\tIN\t${rec.type}\t${formatZoneRdata(rec)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {object} opts
 * @param {string} opts.zone
 * @param {string} opts.serial
 * @param {string} opts.primaryNs
 * @param {string} opts.secondaryNs
 * @param {string} opts.primaryIp
 * @param {string} opts.secondaryIp
 * @param {string} opts.hostmaster
 * @param {{ type: string; name: string; data: string; ttl: number }[]} opts.records
 */
export function renderMasterZoneFile(opts) {
  const header = `; hdc bind — master zone ${opts.zone}\n$TTL 3600\n`;
  const soa = renderSoaLine({
    zone: opts.zone,
    serial: opts.serial,
    primaryNs: opts.primaryNs,
    hostmaster: opts.hostmaster,
  });
  const primaryNsFqdn = opts.primaryNs.endsWith(".") ? opts.primaryNs : `${opts.primaryNs}.`;
  const secondaryNsFqdn = opts.secondaryNs.endsWith(".") ? opts.secondaryNs : `${opts.secondaryNs}.`;
  const primaryGlue = zoneOwnerLabel(primaryNsFqdn.slice(0, -1), opts.zone);
  const secondaryGlue = zoneOwnerLabel(secondaryNsFqdn.slice(0, -1), opts.zone);
  const nsRecs = [
    `@\t3600\tIN\tNS\t${primaryNsFqdn}`,
    `@\t3600\tIN\tNS\t${secondaryNsFqdn}`,
    `${primaryGlue}\t3600\tIN\tA\t${opts.primaryIp}`,
    `${secondaryGlue}\t3600\tIN\tA\t${opts.secondaryIp}`,
  ].join("\n");
  const body = renderZoneRecords(opts.records, opts.zone);
  return `${header}${soa}\n${nsRecs}\n\n${body}`;
}

/**
 * @param {object} opts
 * @param {string[]} opts.allowQueryCidrs
 * @param {boolean} opts.recursion
 * @param {boolean} [opts.dnssecValidation]
 * @param {string[]} [opts.forwarders]
 */
export function renderNamedOptions(opts) {
  const acl = opts.allowQueryCidrs.map((c) => c.trim()).filter(Boolean);
  const forwarders = Array.isArray(opts.forwarders)
    ? opts.forwarders.map((f) => f.trim()).filter(Boolean)
    : [];
  const lines = [
    "// hdc bind — named.conf.options",
    "options {",
    '  directory "/var/cache/bind";',
    "  listen-on-v6 { any; };",
    "  allow-query { any; };",
    `  allow-recursion { ${acl.length ? acl.join("; ") : "localhost"}; };`,
  ];
  if (forwarders.length) {
    lines.push(`  forwarders { ${forwarders.join("; ")}; };`);
  }
  lines.push(
    `  recursion ${opts.recursion ? "yes" : "no"};`,
    `  dnssec-validation ${opts.dnssecValidation === false ? "no" : "auto"};`,
    "};",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Suppress high-volume BIND security/query deny lines (e.g. IoT cache/recursion denials) on syslog.
 */
export function renderNamedLogging() {
  return [
    "// hdc bind — suppress high-volume security deny spam (IoT cache/recursion denials)",
    "logging {",
    "  category security { null; };",
    "  category queries { null; };",
    "  category query-errors { null; };",
    "};",
    "",
  ].join("\n");
}

/**
 * @param {string} secret Base64 or raw TSIG secret (not logged by callers).
 */
export function renderTsigKey(secret) {
  const s = secret.trim().replace(/\s+/g, "");
  return [
    `key "${TSIG_KEY_NAME}" {`,
    "  algorithm hmac-sha256;",
    `  secret "${s}";`,
    "};",
    "",
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {BindRole} opts.role
 * @param {string[]} opts.zoneIds
 * @param {string} opts.primaryIp
 * @param {string} opts.secondaryIp
 */
export function renderNamedLocal(opts) {
  const lines = ["// hdc bind — named.conf.local", ""];
  if (opts.role === "primary") {
    for (const z of opts.zoneIds) {
      const file = zoneFileName(z);
      lines.push(`zone "${z}" {`);
      lines.push("  type master;");
      lines.push(`  file "/var/lib/bind/zones/${file}.zone";`);
      lines.push(`  allow-transfer { key ${TSIG_KEY_NAME}; };`);
      lines.push(`  allow-update { key ${TSIG_KEY_NAME}; };`);
      lines.push(`  also-notify { ${opts.secondaryIp}; };`);
      lines.push("};");
      lines.push("");
    }
  } else {
    for (const z of opts.zoneIds) {
      const file = zoneFileName(z);
      lines.push(`zone "${z}" {`);
      lines.push("  type slave;");
      lines.push(`  masters { ${opts.primaryIp} key ${TSIG_KEY_NAME}; };`);
      lines.push(`  file "/var/lib/bind/secondary/${file}.zone";`);
      lines.push("};");
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {object} opts
 * @param {BindRole} opts.role
 * @param {{ id: string; serial: string; records: { type: string; name: string; data: string; ttl: number }[] }[]} opts.bundles
 * @param {object} opts.ns
 * @param {string} opts.ns.primaryNs
 * @param {string} opts.ns.secondaryNs
 * @param {string} opts.ns.primaryIp
 * @param {string} opts.ns.secondaryIp
 * @param {string} opts.ns.hostmaster
 */
export function renderPrimaryZoneFiles(opts) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const b of opts.bundles) {
    files[b.id] = renderMasterZoneFile({
      zone: b.id,
      serial: b.serial,
      primaryNs: opts.ns.primaryNs,
      secondaryNs: opts.ns.secondaryNs,
      primaryIp: opts.ns.primaryIp,
      secondaryIp: opts.ns.secondaryIp,
      hostmaster: opts.ns.hostmaster,
      records: b.records,
    });
  }
  return files;
}

export { zoneFileName };
