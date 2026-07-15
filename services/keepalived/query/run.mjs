#!/usr/bin/env node
/**
 * Query Keepalived deployment summary and optional live health.
 *
 * Usage: hdc run service keepalived query -- [--instance a | --system-id vm-keepalived-a] [--live]
 *        [--director-only] [--real-server-only]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { createConfigureExec } from "hdc/package/keepalived-configure.mjs";
import {
  directorVipAddresses,
  keepalivedGlobalSettings,
  listKeepalivedDeploymentSummaries,
  normalizeKeepalivedConfig,
  resolveKeepalivedDeployments,
  virtualServersForRealServer,
} from "hdc/package/deployments.mjs";
import {
  queryDrLoVip,
  queryIpvsRules,
  queryKeepalivedConfigPresent,
  queryKeepalivedServiceActive,
  queryVipPresent,
} from "hdc/package/keepalived-query-remote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/keepalived/config.example.json";
/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}
function readCfg() {
  return ensurePackageConfig().data;
}

const target = basename(dirname(here));
const verb = basename(here);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: keepalived query (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const live = flagGet(flags, "live") !== undefined;

  let normalized;
  let deployments;
  let global;
  try {
    normalized = normalizeKeepalivedConfig(cfg);
    global = keepalivedGlobalSettings(normalized);
    deployments = resolveKeepalivedDeployments(cfg, flags);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: msg }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const vipAddresses = directorVipAddresses(normalized.vrrpInstances, normalized.virtualServers);

  /** @type {Record<string, unknown>[]} */
  const nodes = [];

  for (const d of deployments) {
    const ssh = isObject(d.configure) && isObject(d.configure.ssh) ? d.configure.ssh : {};
    const user = resolveGuestSshUser(ssh.user);
    const host = typeof ssh.host === "string" ? ssh.host : "";
    if (!host) {
      nodes.push({ system_id: d.systemId, ok: false, message: "missing ssh host" });
      continue;
    }

    errout.write(`[hdc] ${target} ${verb}: ${d.systemId} at ${user}@${host} …\n`);

    /** @type {Record<string, unknown>} */
    const node = {
      system_id: d.systemId,
      deployment_kind: d.deploymentKind,
      host,
      ok: true,
    };

    if (d.deploymentKind === "director") {
      node.state = d.state;
      node.priority = d.priority;
      node.vrrp_instance_ids = d.vrrpInstanceIds;
    } else {
      node.lb_kind = d.lbKind;
      node.virtual_server_ids = d.virtualServerIds;
    }

    if (live) {
      const exec = createConfigureExec("ssh", { user, host });
      if (d.deploymentKind === "director") {
        const service = queryKeepalivedServiceActive(exec);
        const config = queryKeepalivedConfigPresent(exec);
        const vip = queryVipPresent(exec, vipAddresses);
        const ipvs = queryIpvsRules(exec);
        node.service = service;
        node.config = config;
        node.vip = vip;
        node.ipvs = ipvs;
        node.ok = service.active && config.present;
        if (vip.any_present) {
          node.vip_holder = true;
        }
      } else {
        const vsList = virtualServersForRealServer(normalized.virtualServers, d.virtualServerIds);
        const drVips = vsList.filter(() => d.lbKind === "DR").map((vs) => vs.vip);
        /** @type {Record<string, unknown>[]} */
        const loChecks = [];
        for (const vip of drVips) {
          loChecks.push(queryDrLoVip(exec, vip));
        }
        node.dr_lo_vips = loChecks;
        node.ok = d.lbKind !== "DR" || loChecks.every((c) => c.present);
      }
    }

    nodes.push(node);
  }

  const vipHolder = nodes.find((n) => n.vip_holder === true);
  const ok = nodes.length > 0 && nodes.every((n) => n.ok === true);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        target,
        verb,
        live,
        keepalived: {
          router_id: global.routerId,
          vrrp_instance_count: normalized.vrrpInstances.length,
          virtual_server_count: normalized.virtualServers.length,
          vip_addresses: vipAddresses,
        },
        deployments: listKeepalivedDeploymentSummaries(normalized),
        vip_holder_system_id: vipHolder && typeof vipHolder.system_id === "string" ? vipHolder.system_id : null,
        nodes,
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
