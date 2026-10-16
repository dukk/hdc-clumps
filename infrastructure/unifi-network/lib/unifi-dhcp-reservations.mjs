import { classicDataArray, classicNetworkconf, classicRestWrite, classicUserByMac } from "./unifi-api.mjs";

/**
 * Config-driven UniFi DHCP reservations (client "fixed IP").
 * config.json: "dhcp_reservations": [{ "mac": "aa:bb:..", "ip": "10.0.0.x", "name": "host", "network_id"?: "..." }]
 */

/** @param {string} mac */
export function normalizeReservationMac(mac) {
  const hex = String(mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return "";
  return hex.match(/../g).join(":");
}

/** @param {string} ip */
function ipToInt(ip) {
  const p = String(ip ?? "").trim().split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((a, x) => a * 256 + Number(x), 0);
}

/**
 * @param {unknown} raw
 * @returns {{ mac: string; ip: string; name: string; networkId: string }[]}
 */
export function normalizeDhcpReservationsConfig(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("dhcp_reservations must be an array");
  const seenMac = new Set();
  const seenIp = new Set();
  return raw.map((r, i) => {
    if (!r || typeof r !== "object") throw new Error(`dhcp_reservations[${i}] must be an object`);
    const o = /** @type {Record<string, unknown>} */ (r);
    const mac = normalizeReservationMac(String(o.mac ?? ""));
    if (!mac) throw new Error(`dhcp_reservations[${i}].mac is invalid`);
    const ip = String(o.ip ?? "").trim();
    if (ipToInt(ip) === null) throw new Error(`dhcp_reservations[${i}].ip is invalid`);
    if (seenMac.has(mac)) throw new Error(`dhcp_reservations: duplicate mac ${mac}`);
    if (seenIp.has(ip)) throw new Error(`dhcp_reservations: duplicate ip ${ip}`);
    seenMac.add(mac);
    seenIp.add(ip);
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const networkId = typeof o.network_id === "string" ? o.network_id.trim() : "";
    return { mac, ip, name, networkId };
  });
}

/**
 * Find the UniFi network whose ip_subnet (gateway/prefix) contains ip.
 * @param {Record<string, unknown>[]} networks
 * @param {string} ip
 */
export function networkIdForIp(networks, ip) {
  const target = ipToInt(ip);
  if (target === null) return "";
  for (const n of networks) {
    const subnet = typeof n.ip_subnet === "string" ? n.ip_subnet : "";
    const [addr, bitsStr] = subnet.split("/");
    const base = ipToInt(addr);
    const bits = Number(bitsStr);
    if (base === null || !Number.isInteger(bits) || bits < 1 || bits > 32) continue;
    const size = 2 ** (32 - bits);
    if (Math.floor(base / size) === Math.floor(target / size) && typeof n._id === "string") return n._id;
  }
  return "";
}

/**
 * @param {{ mac: string; ip: string; name: string; networkId: string }} want
 * @param {Record<string, unknown> | null} live rest/user row (or null when unknown)
 * @param {string} networkId
 * @returns {{ action: "create" | "update" | "unchanged"; payload: Record<string, unknown> }}
 */
export function planDhcpReservation(want, live, networkId) {
  const payload = /** @type {Record<string, unknown>} */ ({
    use_fixedip: true,
    fixed_ip: want.ip,
    network_id: networkId,
  });
  if (want.name) payload.name = want.name;
  if (!live) return { action: "create", payload: { mac: want.mac, ...payload } };
  const same =
    live.use_fixedip === true &&
    live.fixed_ip === want.ip &&
    live.network_id === networkId &&
    (!want.name || live.name === want.name);
  return { action: same ? "unchanged" : "update", payload };
}

/**
 * @param {{ base: string; apiKey: string; classicSiteKey: string; rejectUnauthorized: boolean }} ctx
 * @param {{ mac: string; ip: string; name: string; networkId: string }[]} reservations
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyDhcpReservations(ctx, reservations, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const networks = classicDataArray(
    await classicNetworkconf(ctx.base, ctx.apiKey, ctx.classicSiteKey, ctx.rejectUnauthorized),
  );
  /** @type {{ mac: string; ip: string; action: string; ok: boolean; error?: string }[]} */
  const results = [];
  let ok = true;
  for (const want of reservations) {
    const label = `${want.mac} -> ${want.ip}${want.name ? ` (${want.name})` : ""}`;
    try {
      const networkId = want.networkId || networkIdForIp(networks, want.ip);
      if (!networkId) throw new Error(`no UniFi network contains ${want.ip}`);
      const live = await classicUserByMac(ctx.base, ctx.apiKey, ctx.classicSiteKey, want.mac, ctx.rejectUnauthorized);
      const plan = planDhcpReservation(want, live, networkId);
      if (plan.action === "unchanged") {
        log(`DHCP reservation unchanged: ${label}`);
      } else if (dryRun) {
        log(`dry-run: would ${plan.action} DHCP reservation ${label}`);
      } else if (plan.action === "create") {
        await classicRestWrite(ctx.base, ctx.apiKey, ctx.classicSiteKey, "user", "POST", plan.payload, null, ctx.rejectUnauthorized);
        log(`created DHCP reservation ${label}`);
      } else {
        const id = String(live?._id ?? "");
        await classicRestWrite(ctx.base, ctx.apiKey, ctx.classicSiteKey, "user", "PUT", { _id: id, ...plan.payload }, id, ctx.rejectUnauthorized);
        log(`updated DHCP reservation ${label}`);
      }
      results.push({ mac: want.mac, ip: want.ip, action: plan.action, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`FAILED DHCP reservation ${label}: ${msg}`);
      results.push({ mac: want.mac, ip: want.ip, action: "error", ok: false, error: msg });
      ok = false;
    }
  }
  return { ok, results };
}