#!/usr/bin/env node
/**
 * Health check for minecraft (DNS + Java TCP 25565; BlueMap HTTPS when enabled).
 *
 * Usage: hdc run service minecraft health -- [--instance a]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { resolveMinecraftDeployments } from "hdc/package/deployments.mjs";
import { tcpConnect } from "hdc/package/query-status.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const target = basename(dirname(here));
const CLUMP_CONFIG_EXAMPLE = "clumps/services/minecraft/config.example.json";
const PUBLIC_HOST = "minecraft.dukk.org";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function probeDns(hostname) {
  if (!hostname) return { ok: null, skipped: true, detail: "no hostname" };
  try {
    const addrs = await lookup(hostname, { all: true });
    const ips = addrs.map((a) => a.address);
    return { ok: ips.length > 0, skipped: false, hostname, addresses: ips };
  } catch (e) {
    return {
      ok: false,
      skipped: false,
      hostname,
      detail: String(/** @type {Error} */ (e).message || e).slice(0, 200),
    };
  }
}

/**
 * @param {string} url
 */
async function probeHttps(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.text().catch(() => "");
    const bluemap = /bluemap/i.test(body);
    const ok = res.status >= 200 && res.status < 400 && bluemap;
    return {
      ok,
      skipped: false,
      status: res.status,
      url,
      bluemap,
      detail: bluemap ? undefined : "response is not BlueMap HTML",
    };
  } catch (e) {
    const cause =
      e && typeof e === "object" && "cause" in e
        ? /** @type {{ message?: string }} */ (e.cause)
        : null;
    return {
      ok: false,
      skipped: false,
      url,
      detail: String(cause?.message || /** @type {Error} */ (e).message || e).slice(0, 200),
    };
  }
}

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  errout.write(`[hdc] ${target} health: family=qemu-native tcp=25565\n`);

  const loaded = tryLoadClumpConfigFromClumpRoot(clumpRoot, {
    exampleRel: CLUMP_CONFIG_EXAMPLE,
  });
  if (!loaded?.ok || !isObject(loaded.data)) {
    const payload = { ok: false, target, verb: "health", message: "clump config missing" };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  let deployments;
  try {
    deployments = resolveMinecraftDeployments(loaded.data, flags);
  } catch (e) {
    const payload = {
      ok: false,
      target,
      verb: "health",
      message: String(/** @type {Error} */ (e).message || e),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const instances = [];
  /** @type {string[]} */
  const statuses = [];

  for (const d of deployments) {
    errout.write(`[hdc] ${target} health: probing ${d.systemId}\n`);
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const q = isObject(px.qemu) ? px.qemu : {};
    const configure = isObject(d.configure) ? d.configure : {};
    const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
    const ip = typeof q.ip === "string" ? q.ip.trim() : "";
    const guestIp =
      typeof sshCfg.host === "string" && sshCfg.host.trim()
        ? sshCfg.host.trim()
        : ip.split("/")[0];
    const javaPort = d.minecraft?.javaPort || 25565;
    const bluemap = d.minecraft?.bluemap === true;
    const bluemapPort = Number(d.minecraft?.bluemapWebPort) || 8100;
    const hostname =
      typeof d.hostname === "string" && d.hostname.trim()
        ? `${d.hostname.trim()}.hdc.dukk.org`
        : PUBLIC_HOST;

    const dns = await probeDns(hostname);
    const publicDns = hostname.includes("hdc.dukk.org") ? await probeDns(PUBLIC_HOST) : dns;
    const tcpOk = guestIp ? await tcpConnect(guestIp, javaPort) : false;
    const bluemapTcp = bluemap && guestIp ? await tcpConnect(guestIp, bluemapPort) : null;
    const wafHttps = bluemap ? await probeHttps(`https://${PUBLIC_HOST}/`) : null;

    let status = "unknown";
    if (!guestIp) status = "unknown";
    else if (!tcpOk) status = "down";
    else if (bluemap && bluemapTcp === false) status = "degraded";
    else if (bluemap && wafHttps && wafHttps.ok === false) status = "degraded";
    else status = "healthy";
    statuses.push(status);
    instances.push({
      id: d.systemId,
      system_id: d.systemId,
      status,
      layers: {
        dns: publicDns,
        lan_dns: dns,
        public: bluemap
          ? wafHttps
          : { ok: null, skipped: true, detail: "game protocol, not HTTP" },
        waf: bluemap
          ? wafHttps
          : { ok: null, skipped: true, detail: "game protocol, not HTTP" },
        direct: {
          ok: tcpOk,
          skipped: !guestIp,
          detail: guestIp ? `tcp ${guestIp}:${javaPort}` : "no guest ip",
        },
        bluemap: bluemap
          ? {
              ok: bluemapTcp,
              skipped: !guestIp,
              detail: guestIp ? `tcp ${guestIp}:${bluemapPort}` : "no guest ip",
            }
          : { ok: null, skipped: true, detail: "bluemap disabled" },
      },
    });
  }

  const overall =
    statuses.every((s) => s === "healthy")
      ? "healthy"
      : statuses.some((s) => s === "down")
        ? "down"
        : statuses.some((s) => s === "degraded")
          ? "degraded"
          : "unknown";
  const ok = overall !== "down";
  const payload = {
    ok,
    target,
    verb: "health",
    family: "qemu-native",
    status: overall,
    instances,
    generated_at: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  errout.write(`[hdc] ${target} health: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb: "health", message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exit(1);
});
