#!/usr/bin/env node
/**
 * Query Pi-hole instance status.
 *
 * Usage: hdc run service pi-hole query -- [--instance a | --system-id pi-hole-a] [--live]
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { loadManualSystemSidecar, primaryIpFromSystem } from "hdc/package/inventory.mjs";
import { resolvePiHoleDeployments } from "hdc/package/deployments.mjs";
import { readCtPrimaryIp, resolvePveSshForHost } from "hdc/package/pi-hole-install.mjs";
import { allowlistFromPiholeConfig, queryLiveAllowlistInCt } from "hdc/package/pi-hole-allowlist.mjs";
import { queryPiHoleStatusInCt } from "hdc/package/pi-hole-configure.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/pi-hole/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

const target = basename(dirname(here));
const verb = basename(here);
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readCfg() {
  return ensurePackageConfig().data;
}

/**
 * @param {ReturnType<typeof resolvePiHoleDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 */
async function queryOne(deployment, flags) {
  const { systemId, proxmox: px } = deployment;
  if (!isObject(px)) {
    return { ok: false, system_id: systemId, message: "bad proxmox config" };
  }
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
  if (!hostId || !Number.isFinite(vmid) || vmid <= 0) {
    return { ok: false, system_id: systemId, message: "missing host_id or vmid" };
  }

  errout.write(`[hdc] ${target} ${verb}: ${systemId} on ${hostId} vmid ${vmid} …\n`);
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const sidecar = loadManualSystemSidecar(root, systemId);
  let ip = primaryIpFromSystem(sidecar);
  if (!ip) {
    ip = readCtPrimaryIp(pveSsh.user, pveSsh.host, vmid);
  }

  const status = queryPiHoleStatusInCt(pveSsh.user, pveSsh.host, vmid);
  /** @type {Record<string, unknown>} */
  const row = {
    system_id: systemId,
    host_id: hostId,
    vmid,
    ip,
    url: ip ? `http://${ip}/admin/` : null,
    ok: status.ok,
    status,
  };

  if (flags.live !== undefined) {
    const piholeCfg = isObject(deployment.pihole) ? deployment.pihole : {};
    let configured;
    try {
      configured = allowlistFromPiholeConfig(piholeCfg);
    } catch (e) {
      row.allowlist = {
        ok: false,
        message: String(/** @type {Error} */ (e).message || e),
      };
      row.ok = false;
      return row;
    }
    const live = queryLiveAllowlistInCt(pveSsh.user, pveSsh.host, vmid);
    row.allowlist = {
      ok: live.ok,
      configured_count: configured.length,
      configured_domains: configured.map((entry) => entry.domain),
      live_count: live.count ?? live.domains?.length ?? 0,
      live_domains: live.domains ?? [],
      message: live.message,
    };
    if (!live.ok) row.ok = false;
  }

  return row;
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: Pi-hole status (stderr log; JSON on stdout).\n`);

  if (!existsSync(ensurePackageConfig().path)) {
    errout.write(`[hdc] ${target} ${verb}: missing clumps/services/pi-hole/config.json\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: "clump config missing" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  let deployments;
  try {
    deployments = resolvePiHoleDeployments(cfg, flags, { skipInstall: true });
  } catch (e) {
    errout.write(`[hdc] ${target} ${verb}: ${/** @type {Error} */ (e).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  /** @type {Record<string, unknown>[]} */
  const instances = [];
  for (const deployment of deployments) {
    try {
      instances.push(await queryOne(deployment, flags));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
      instances.push({ ok: false, system_id: deployment.systemId, message: msg });
    }
  }

  const ok = instances.every((r) => r.ok);
  const payload = { ok, target, verb, count: instances.length, instances };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
