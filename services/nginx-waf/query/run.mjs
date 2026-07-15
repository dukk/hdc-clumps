#!/usr/bin/env node
/**
 * Query nginx WAF health on configured nodes.
 *
 * Flags:
 *   --live                    Include live vhost drift
 *   --failing-only            Only include sites whose upstream probes failed
 *   --inventory-crosscheck    For failing upstreams, map IP → inventory system + optional Proxmox status
 *   --from-operator           Also curl failing upstreams from the operator host
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  resolveNginxWafDeployments,
  resolveNginxWafGroups,
  sshTargetFromDeployment,
} from "hdc/package/deployments.mjs";
import { createConfigureExec } from "hdc/package/nginx-waf-configure.mjs";
import { queryCertExpiry } from "hdc/package/letsencrypt.mjs";
import { queryLiveVhostDrift } from "hdc/package/nginx-waf-vhost-drift.mjs";
import { loadClumpConfigFromClumpRoot, tryLoadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { loadManualSystemSidecar, primaryIpFromSystem } from "hdc/package/inventory-sidecar.mjs";
import { hdcPrivateRoot } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { resolvePveSshForHost } from "../../../infrastructure/proxmox/lib/proxmox-pve-ssh.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";

import {
  modsecurityProfilePath,
  resolveLocationPolicyPlan,
  resolveSitePolicyPlan,
} from "hdc/package/nginx-waf-policies.mjs";
import {
  MODSECURITY_RULES_FILE,
  siteId,
  tlsDomainsFromSites,
} from "hdc/package/nginx-waf-render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/nginx-waf/config.example.json";
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
function tryCfg() {
  return tryLoadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
}

const target = basename(dirname(here));
const verb = basename(here);

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 */
function queryNginxActive(exec) {
  const r = exec.run("systemctl is-active nginx 2>/dev/null || echo inactive", { capture: true });
  const active = r.stdout.trim() === "active";
  return { active, raw: r.stdout.trim() };
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 */
function queryNginxTest(exec) {
  const r = exec.run("nginx -t 2>&1", { capture: true });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim().slice(0, 500) };
}

/**
 * @param {ReturnType<typeof resolveSitePolicyPlan>} plan
 */
function policyTypesFromPlan(plan) {
  return Object.keys(plan).filter((k) => plan[k] != null);
}

/**
 * @param {Record<string, unknown>} site
 * @param {Record<string, Record<string, unknown>>} catalog
 */
function summarizeSitePolicies(site, catalog) {
  const id = siteId(site);
  const sitePlan = resolveSitePolicyPlan(site, catalog, id);
  const locations = Array.isArray(site.locations) ? site.locations.filter(isObject) : [];
  const locSummaries = locations.map((loc, index) => {
    const locPlan = resolveLocationPolicyPlan(site, loc, index, catalog, sitePlan);
    return {
      path: typeof loc.path === "string" ? loc.path : "/",
      policy_types: policyTypesFromPlan(locPlan),
      modsecurity_enabled: locPlan.modsecurity?.enabled ?? null,
    };
  });
  return {
    id,
    policy_types: policyTypesFromPlan(sitePlan),
    modsecurity_profile: sitePlan.modsecurity?.profileId ?? null,
    modsecurity_enabled: sitePlan.modsecurity?.enabled ?? null,
    locations: locSummaries,
  };
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {ReturnType<typeof nginxWafGroupSettings>} global
 */
function queryModsecurityStatus(exec, global) {
  if (!global.modsecurityEnabled) {
    return { enabled: false, ok: true, profiles: [] };
  }

  const plan = global.groupPolicyPlan;
  const profileIds =
    plan?.modsecurityProfiles?.map((p) => String(p.profileId)).filter(Boolean) ?? [];
  const rulesFiles = profileIds.length
    ? profileIds.map((id) => modsecurityProfilePath(id))
    : [MODSECURITY_RULES_FILE];

  /** @type {Record<string, unknown>[]} */
  const profiles = [];
  let allPresent = true;
  let primaryRuleEngine = null;

  for (let i = 0; i < rulesFiles.length; i++) {
    const rulesFile = rulesFiles[i];
    const profileId = profileIds[i] ?? "default";
    const exists = exec.run(`test -f ${rulesFile}`, { capture: true }).status === 0;
    if (!exists) allPresent = false;
    let ruleEngine = null;
    if (exists) {
      const read = exec.run(`grep -E '^SecRuleEngine' ${rulesFile} 2>/dev/null | head -1`, {
        capture: true,
      });
      const m = read.stdout.trim().match(/^SecRuleEngine\s+(\S+)/);
      ruleEngine = m ? m[1] : null;
      if (!primaryRuleEngine) primaryRuleEngine = ruleEngine;
    }
    profiles.push({
      profile_id: profileId,
      rules_file: rulesFile,
      rules_file_present: exists,
      rule_engine: ruleEngine,
    });
  }

  const crsCount = exec.run(
    "sh -c 'ls /usr/share/modsecurity-crs/rules/*.conf 2>/dev/null | wc -l'",
    { capture: true },
  );
  const crsRuleFiles = Number.parseInt(crsCount.stdout.trim(), 10) || 0;

  const modProbe = exec.run("nginx -V 2>&1", { capture: true });
  const modProbeText = `${modProbe.stdout}${modProbe.stderr}`;
  const moduleLoaded =
    modProbeText.includes("modsecurity") ||
    exec.run("test -f /etc/nginx/modules-enabled/50-mod-http-modsecurity.conf", {
      capture: true,
    }).status === 0 ||
    exec.run(
      "sh -c 'test -f /usr/lib/nginx/modules/ngx_http_modsecurity_module.so || test -f /usr/share/nginx/modules/ngx_http_modsecurity_module.so'",
      { capture: true },
    ).status === 0;

  const auditLog = global.modsecurityAuditLog;
  const auditPresent = exec.run(`test -f ${auditLog}`, { capture: true }).status === 0;

  const ok = allPresent && crsRuleFiles > 0 && moduleLoaded;
  return {
    enabled: true,
    ok,
    rules_file: rulesFiles[0],
    rules_file_present: allPresent,
    rule_engine: primaryRuleEngine,
    profiles,
    crs_rule_files: crsRuleFiles,
    module_loaded: moduleLoaded,
    audit_log: auditLog,
    audit_log_present: auditPresent,
  };
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 */
function queryEnabledSites(exec) {
  const r = exec.run("ls -1 /etc/nginx/sites-enabled/hdc-*.conf 2>/dev/null | xargs -r basename -a", {
    capture: true,
  });
  const ids = r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^hdc-/, "").replace(/\.conf$/, ""));
  return ids;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} upstream
 */
function probeUpstream(exec, upstream) {
  // Avoid `curl -f` + `|| echo fail`: on connect failure curl prints `000` then
  // echo appends `fail` → `000fail`, which previously scored as ok.
  const r = exec.run(
    `curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 ${JSON.stringify(upstream)} 2>/dev/null || true`,
    { capture: true },
  );
  const code = r.stdout.trim();
  const ok = /^[1-9]\d{2}$/.test(code);
  return { upstream, ok, http_code: code };
}

/**
 * @param {string} upstream
 */
function upstreamHostPort(upstream) {
  try {
    const u = new URL(upstream);
    return { host: u.hostname, port: u.port || (u.protocol === "https:" ? "443" : "80") };
  } catch {
    return null;
  }
}

/**
 * @param {string} ip
 * @param {string} root
 * @param {string | null} privateRoot
 */
function inventorySystemsForIp(ip, root, privateRoot) {
  /** @type {{ system_id: string; path: string }[]} */
  const hits = [];
  const dirs = [
    join(root, "inventory", "manual", "systems"),
    privateRoot ? join(privateRoot, "inventory", "manual", "systems") : null,
  ].filter(Boolean);
  /** @type {Set<string>} */
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || name.startsWith("_")) continue;
      const systemId = name.replace(/\.json$/, "");
      if (seen.has(systemId)) continue;
      const system = loadManualSystemSidecar(root, systemId);
      if (!system) continue;
      const sip = primaryIpFromSystem(system);
      if (sip === ip) {
        seen.add(systemId);
        hits.push({ system_id: systemId, path: `inventory/manual/systems/${systemId}.json` });
      }
    }
  }
  return hits;
}

/**
 * @param {string} systemId
 * @param {string} root
 * @param {string} proxmoxRoot
 */
function proxmoxPowerForSystem(systemId, root, proxmoxRoot) {
  const system = loadManualSystemSidecar(root, systemId);
  if (!system) return null;
  const px = system.proxmox && typeof system.proxmox === "object" ? /** @type {Record<string, unknown>} */ (system.proxmox) : null;
  if (!px) return null;
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  const qemu = px.qemu && typeof px.qemu === "object" ? /** @type {Record<string, unknown>} */ (px.qemu) : null;
  const lxc = px.lxc && typeof px.lxc === "object" ? /** @type {Record<string, unknown>} */ (px.lxc) : null;
  const vmidRaw = qemu?.vmid ?? lxc?.vmid;
  const vmid = typeof vmidRaw === "number" ? vmidRaw : Number(vmidRaw);
  if (!hostId || !Number.isFinite(vmid)) return null;
  try {
    const ssh = resolvePveSshForHost(proxmoxRoot, hostId);
    const kind = lxc ? "pct" : "qm";
    const r = sshRemote(ssh.user, ssh.host, `${kind} status ${vmid}`, { capture: true });
    return {
      host_id: hostId,
      vmid,
      type: lxc ? "lxc" : "qemu",
      ok: r.status === 0,
      status: (r.stdout || r.stderr || "").trim(),
    };
  } catch (e) {
    return { host_id: hostId, vmid, error: String(/** @type {Error} */ (e).message || e) };
  }
}

/**
 * @param {string} upstream
 */
function operatorCurl(upstream) {
  const r = spawnSync(
    "curl",
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "3", upstream],
    { encoding: "utf8" },
  );
  const code = (r.stdout || "").trim();
  return { ok: /^[1-9]\d{2}$/.test(code), http_code: code, status: r.status };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: nginx WAF health check (JSON on stdout).\n`);

  const cfg = readCfg();
  const flags = parseArgvFlags(process.argv.slice(2));
  const liveDrift = flagGet(flags, "live") !== undefined;
  const failingOnly = flagGet(flags, "failing-only", "failing_only") !== undefined;
  const inventoryCrosscheck =
    flagGet(flags, "inventory-crosscheck", "inventory_crosscheck") !== undefined;
  const fromOperator = flagGet(flags, "from-operator", "from_operator") !== undefined;
  const root = repoRoot();
  const privateRoot = hdcPrivateRoot(root) ?? null;
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const groupContexts = resolveNginxWafGroups(cfg, flags);
  /** @type {Map<string, ReturnType<typeof resolveNginxWafGroups>[number]>} */
  const ctxBySystemId = new Map();
  for (const ctx of groupContexts) {
    for (const d of ctx.deployments) {
      ctxBySystemId.set(d.systemId, ctx);
    }
  }
  const deployments = resolveNginxWafDeployments(cfg, flags);

  /** @type {Record<string, unknown>[]} */
  const nodes = [];

  for (const d of deployments) {
    const ctx = ctxBySystemId.get(d.systemId);
    if (!ctx) continue;
    const global = ctx.global;
    const sites = ctx.sites;
    const domains = tlsDomainsFromSites(sites, global);
    const { user, host } = sshTargetFromDeployment(d);
    errout.write(`[hdc] ${target} ${verb}: checking ${d.systemId} (${d.role}) at ${user}@${host} …\n`);
    const exec = createConfigureExec("ssh", { user, host });
    const nginx = queryNginxActive(exec);
    const configTest = queryNginxTest(exec);
    const modsec = queryModsecurityStatus(exec, global);
    const enabledSites = queryEnabledSites(exec);

    /** @type {Record<string, unknown>[]} */
    let siteProbes = [];
    /** @type {Record<string, unknown>[]} */
    const sitePolicies = [];
    for (const site of sites) {
      sitePolicies.push(summarizeSitePolicies(site, global.policyDefinitions));
      const upstream =
        typeof site.upstream === "string" && site.upstream.trim() ? site.upstream.trim() : "";
      if (upstream) {
        siteProbes.push({
          id: siteId(site),
          probe: probeUpstream(exec, upstream),
        });
      }
    }

    if (failingOnly) {
      siteProbes = siteProbes.filter((p) => {
        const probe = /** @type {{ ok?: boolean }} */ (p.probe);
        return probe && probe.ok === false;
      });
    }

    if (inventoryCrosscheck || fromOperator) {
      for (const row of siteProbes) {
        const probe = /** @type {{ upstream?: string; ok?: boolean }} */ (row.probe);
        if (!probe?.upstream || probe.ok !== false) continue;
        const hp = upstreamHostPort(probe.upstream);
        if (!hp) continue;
        if (fromOperator) {
          row.operator_probe = operatorCurl(probe.upstream);
        }
        if (inventoryCrosscheck) {
          const systems = inventorySystemsForIp(hp.host, root, privateRoot);
          row.inventory = systems.map((s) => ({
            ...s,
            proxmox: proxmoxPowerForSystem(s.system_id, root, proxmoxRoot),
          }));
        }
      }
    }

    /** @type {Record<string, unknown>[]} */
    const certs = domains.map((domain) => ({
      ...queryCertExpiry(exec, domain),
    }));

    const vhostAudit = liveDrift ? queryLiveVhostDrift(exec, sites) : null;

    const failingCount = siteProbes.filter((p) => {
      const probe = /** @type {{ ok?: boolean }} */ (p.probe);
      return probe && probe.ok === false;
    }).length;

    nodes.push({
      system_id: d.systemId,
      deployment_group: ctx.groupId,
      role: d.role,
      host,
      nginx,
      config_test: configTest,
      modsecurity: modsec,
      group_policies: {
        uses_modsecurity: global.groupPolicyPlan?.usesModsecurity ?? false,
        modsecurity_profiles: (global.groupPolicyPlan?.modsecurityProfiles ?? []).map(
          (p) => p.profileId,
        ),
        rate_limit_zones: (global.groupPolicyPlan?.rateLimitZones ?? []).map((z) => z.zoneName),
        block_common_exploits: global.groupPolicyPlan?.blockCommonExploits ?? false,
      },
      enabled_sites: enabledSites,
      site_policies: failingOnly ? undefined : sitePolicies,
      site_probes: siteProbes,
      failing_upstream_count: failingCount,
      certificates: failingOnly ? undefined : certs,
      ...(vhostAudit
        ? {
            live_sites: vhostAudit.live_sites,
            vhost_drift: vhostAudit.vhost_drift,
          }
        : {}),
      ok:
        nginx.active &&
        configTest.ok &&
        modsec.ok !== false &&
        (vhostAudit ? vhostAudit.ok : true) &&
        (!failingOnly || failingCount === 0),
    });
  }

  const ok = nodes.length > 0 && nodes.every((n) => n.ok);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        target,
        verb,
        failing_only: failingOnly,
        inventory_crosscheck: inventoryCrosscheck,
        from_operator: fromOperator,
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
