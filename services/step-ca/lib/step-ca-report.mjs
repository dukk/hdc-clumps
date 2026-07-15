/**
 * @param {ReturnType<typeof import("./deployments.mjs").stepCaGlobalSettings>} global
 */
export function stepCaPayloadMeta(global) {
  return {
    dns_names: global.dnsNames,
    listen_address: global.listenAddress,
    enable_acme: global.enableAcme,
    provisioner_name: global.provisionerName,
  };
}

/**
 * @param {string} host hostname or IP (no scheme)
 * @param {string} listenAddress e.g. :443
 * @returns {string}
 */
export function stepCaHttpsBase(host, listenAddress) {
  const trimmed = host.trim();
  if (!trimmed) return "";
  const port = listenAddress.startsWith(":") ? listenAddress.slice(1) : "443";
  if (port === "443") return `https://${trimmed}`;
  return `https://${trimmed}:${port}`;
}

/**
 * @param {object} opts
 * @param {string[]} opts.dnsNames
 * @param {string} [opts.ip]
 * @param {string} opts.listenAddress
 * @param {boolean} opts.enableAcme
 * @returns {{ label: string; url: string }[]}
 */
export function stepCaEndpointList(opts) {
  const { dnsNames, ip, listenAddress, enableAcme } = opts;
  const primaryHost = dnsNames[0]?.trim() || ip?.trim() || "";
  if (!primaryHost) return [];

  const base = stepCaHttpsBase(primaryHost, listenAddress);
  /** @type {{ label: string; url: string }[]} */
  const endpoints = [
    { label: "Health", url: `${base}/health` },
    { label: "Root CA (PEM)", url: `${base}/roots.pem` },
  ];
  if (enableAcme) {
    endpoints.push({ label: "ACME directory", url: `${base}/acme/acme/directory` });
  }
  const ipTrim = ip?.trim();
  const dnsTrim = dnsNames[0]?.trim();
  if (ipTrim && dnsTrim && ipTrim !== dnsTrim) {
    const ipBase = stepCaHttpsBase(ipTrim, listenAddress);
    endpoints.push({ label: "Health (direct IP)", url: `${ipBase}/health` });
  }
  return endpoints;
}

/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function stepCaReportExtraSections(ctx) {
  const lines = ["## step-ca endpoints", ""];
  const sc = ctx.stdoutPayload?.step_ca;
  const dnsNames = Array.isArray(sc?.dns_names)
    ? sc.dns_names.map((d) => String(d).trim()).filter(Boolean)
    : [];
  const listenAddress =
    typeof sc?.listen_address === "string" && sc.listen_address.trim()
      ? sc.listen_address.trim()
      : ":443";
  const enableAcme = sc?.enable_acme !== false;
  const provisioner =
    typeof sc?.provisioner_name === "string" && sc.provisioner_name.trim()
      ? sc.provisioner_name.trim()
      : "admin";

  /** @type {Map<string, string>} */
  const ipBySystem = new Map();
  for (const inv of ctx.inventory ?? []) {
    if (inv.inventoryIp?.trim()) ipBySystem.set(inv.systemId, inv.inventoryIp.trim());
  }

  const results = ctx.stdoutPayload?.results;
  if (!Array.isArray(results) || !results.length) {
    lines.push("_No instance results._", "");
    return lines;
  }

  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = row.system_id;
    if (typeof sid !== "string") continue;
    const host =
      typeof row.host === "string" && row.host.trim()
        ? row.host.trim()
        : ipBySystem.get(sid) ?? "";
    const endpoints = stepCaEndpointList({
      dnsNames,
      ip: host,
      listenAddress,
      enableAcme,
    });
    lines.push(
      `- **${sid}:**${row.ok === true ? " ok" : row.ok === false ? " failed" : ""}`,
    );
    if (dnsNames.length) {
      lines.push(`  - DNS: ${dnsNames.join(", ")}`);
    }
    if (host) {
      lines.push(`  - Host/IP: ${host}`);
    }
    if (!endpoints.length) {
      lines.push(`  - _Set DNS or host/IP in config/inventory to list URLs._`);
    } else {
      for (const ep of endpoints) {
        lines.push(`  - ${ep.label}: ${ep.url}`);
      }
    }
  }

  lines.push(
    "",
    "No web admin UI — use the `step` CLI with provisioner `" +
      provisioner +
      "` and your vault CA password.",
    "",
  );
  return lines;
}
