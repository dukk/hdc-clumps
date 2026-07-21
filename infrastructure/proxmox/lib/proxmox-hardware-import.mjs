/**
 * Import Proxmox hypervisor hardware into operations/inventory/systems/pve-*.json.
 */
import { spawnSync } from "node:child_process";
import { stderr as errout } from "node:process";

import {
  discoverLocalSshMaterial,
  sshBashLc,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { repoRoot as defaultRepoRoot } from "hdc/cli/paths.mjs";
import {
  hardwareFromProxmoxNodeStatus,
  upsertPhysicalSystemHardware,
} from "hdc/package/hardware-inventory.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { hardwareCommand, parseHardwareOutput } from "hdc/clump/services/meshcentral/lib/meshcentral-ops.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import {
  buildOemLicenseProbeScript,
  parseOemLicenseProbeOutput,
} from "./proxmox-oem-windows-license.mjs";
import {
  clusterConfigByKey,
  isProxmoxConfigObject,
  loadProxmoxHostsByCluster,
} from "./proxmox-config.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { pveData, pveJsonRequest } from "./pve-http.mjs";
import { hdcTlsRejectUnauthorized } from "hdc/cli/lib/tls-insecure-env.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} hostRow config host object
 */
function accessNodeFromHost(hostRow) {
  if (!isObject(hostRow)) return null;
  /** @type {Record<string, unknown>} */
  const node = { name: "primary" };
  if (typeof hostRow.ip === "string" && hostRow.ip.trim()) node.ip = hostRow.ip.trim();
  if (typeof hostRow.web_ui === "string" && hostRow.web_ui.trim()) node.web_ui = hostRow.web_ui.trim();
  if (typeof hostRow.ssh === "string" && hostRow.ssh.trim()) node.ssh = hostRow.ssh.trim();
  return node;
}

/**
 * Collect hardware for one hypervisor: API status + optional SSH collector + OEM MSDM/SLIC.
 * @param {object} opts
 */
export async function collectProxmoxHostHardware(opts) {
  const {
    hostId,
    pveNode,
    hostRow,
    pveGet,
    sshTarget,
    env,
    spawnSync: spawn,
    identities,
    dryRun = false,
    log = () => {},
  } = opts;

  /** @type {unknown} */
  let statusBody = null;
  try {
    statusBody = await pveGet(`/nodes/${encodeURIComponent(pveNode)}/status`);
  } catch (e) {
    log(`[${hostId}] node status failed: ${/** @type {Error} */ (e).message || e}`);
  }

  /** @type {Record<string, unknown>[] | null} */
  let sshHardware = null;
  /** @type {{ msdm: boolean; slic: boolean } | null} */
  let oemFirmware = null;

  if (sshTarget && !dryRun) {
    if (sshReachableWithPubkey(sshTarget, spawn, env, identities)) {
      log(`[${hostId}] collecting hardware over SSH …`);
      const hwScript = hardwareCommand("linux");
      const hwResult = sshBashLc(sshTarget, hwScript, {
        spawnSync: spawn,
        env,
        mode: "pubkey",
        identities,
        timeoutMs: 90_000,
      });
      const hwOut = String(hwResult.stdout || "");
      if (hwResult.status === 0) {
        const parsed = parseHardwareOutput(hwOut);
        if (parsed.ok) sshHardware = parsed.hardware;
        else log(`[${hostId}] hardware parse failed: ${parsed.message}`);
      } else {
        log(`[${hostId}] hardware SSH failed (exit ${hwResult.status})`);
      }

      const oemScript = buildOemLicenseProbeScript(pveNode);
      const oemResult = sshBashLc(sshTarget, oemScript, {
        spawnSync: spawn,
        env,
        mode: "pubkey",
        identities,
        timeoutMs: 30_000,
      });
      if (oemResult.status === 0) {
        const probed = parseOemLicenseProbeOutput(String(oemResult.stdout || ""), pveNode);
        oemFirmware = probed.firmware;
      }
    } else {
      log(`[${hostId}] SSH unreachable; using API status only`);
    }
  }

  const hardware = hardwareFromProxmoxNodeStatus({
    statusBody,
    sshHardware,
    oemFirmware,
  });

  return {
    hostId,
    pveNode,
    hardware,
    accessNode: accessNodeFromHost(hostRow),
    status: statusBody ? pveData(statusBody) : null,
    oem_firmware: oemFirmware,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.publicRoot
 * @param {string} opts.clumpRoot
 * @param {unknown} opts.cfg
 * @param {Map<string, import("./proxmox-config.mjs").ProxmoxClusterMember[]>} opts.byCluster
 * @param {import("hdc/cli/lib/vault-access.mjs").VaultAccess} opts.vault
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof spawnSync} [opts.spawnSync]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.yes]
 * @param {(line: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.warn]
 */
export async function importProxmoxHostHardware(opts) {
  const {
    publicRoot,
    clumpRoot,
    cfg,
    byCluster,
    vault,
    env = process.env,
    spawnSync: spawn = spawnSync,
    dryRun = false,
    yes = false,
    log = () => {},
    warn = () => {},
  } = opts;

  if (!yes && !dryRun) {
    return { ok: false, message: "query --import-hardware requires --yes (or --dry-run)", written: [] };
  }
  if (!isProxmoxConfigObject(cfg)) {
    return { ok: false, message: "invalid proxmox config", written: [] };
  }

  const sshTargets = listProxmoxHypervisorSshTargets(cfg, env);
  /** @type {Map<string, { id: string; user: string; host: string }>} */
  const sshById = new Map(sshTargets.map((t) => [t.id, t]));
  const { identities } = discoverLocalSshMaterial();

  /** @type {{ id: string; rel: string; created: boolean; hardware_count: number }[]} */
  const written = [];
  /** @type {string[]} */
  const errors = [];

  for (const [ck, members] of byCluster) {
    if (!members?.length) continue;
    const configCluster = clusterConfigByKey(cfg, ck);
    const authBundle = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn,
      verifyPaths: PROXMOX_MAINTAIN_VERIFY_PATHS,
      configCluster,
      log,
    });
    if (!authBundle) {
      const msg = `no API token for cluster group ${ck}`;
      warn(msg);
      errors.push(msg);
      continue;
    }

    const authorization = authBundle.authorization;
    const rejectUnauthorized =
      typeof authBundle.rejectUnauthorized === "boolean"
        ? authBundle.rejectUnauthorized
        : hdcTlsRejectUnauthorized(env, "HDC_PROXMOX_TLS_INSECURE");
    const apiBase = authBundle.host?.apiBase ?? members[0].apiBase;

    for (const m of members) {
      const hostRow = isObject(m.host) ? m.host : {};
      if (hostRow.down === true) {
        log(`[${m.id}] skipped (down: true)`);
        continue;
      }

      const nodeApiBase = m.apiBase || apiBase;
      const collected = await collectProxmoxHostHardware({
        hostId: m.id,
        pveNode: m.pveNode,
        hostRow,
        pveGet: (path) =>
          pveJsonRequest("GET", nodeApiBase, path, authorization, rejectUnauthorized, undefined),
        sshTarget: sshById.get(m.id) ?? null,
        env,
        spawnSync: spawn,
        identities,
        dryRun,
        log,
      });

      if (!collected.hardware.length) {
        warn(`[${m.id}] no hardware fields collected`);
      }

      const result = upsertPhysicalSystemHardware({
        publicRoot,
        systemId: m.id,
        hardware: collected.hardware,
        source: "proxmox",
        accessNode: collected.accessNode ?? undefined,
        tags: ["proxmox"],
        automationTargets: ["proxmox"],
        dryRun,
        log,
      });
      written.push({
        id: result.id,
        rel: result.rel,
        created: result.created,
        hardware_count: collected.hardware.length,
      });
    }
  }

  return {
    ok: errors.length === 0,
    written,
    errors,
    dry_run: dryRun,
  };
}

/**
 * @param {string[]} argv
 * @param {string} clumpRoot
 * @returns {Promise<object | null>}
 */
export async function maybeRunProxmoxHardwareImport(argv, clumpRoot) {
  const flags = parseArgvFlags(argv);
  if (flagGet(flags, "import-hardware", "import_hardware") === undefined) return null;

  const yes = flagGet(flags, "yes") !== undefined;
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  const log = (line) => errout.write(`[proxmox] query: ${line}\n`);
  const warn = (line) => errout.write(`[proxmox] query: WARN ${line}\n`);
  const publicRoot = defaultRepoRoot();
  const deps = createNodeCliDeps();
  const vault = createVaultAccess(vaultDepsFromCli(deps));
  await vault.unlock({});

  const loaded = loadProxmoxPackageConfig(clumpRoot, { publicRoot });
  const byCluster = loadProxmoxHostsByCluster(loaded.data, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => log(`skip ${JSON.stringify(id)} (${reason})`),
  });

  log(
    `import-hardware: ${[...byCluster.values()].reduce((n, m) => n + m.length, 0)} host(s)${dryRun ? " [dry-run]" : ""}`,
  );
  const result = await importProxmoxHostHardware({
    publicRoot,
    clumpRoot,
    cfg: loaded.data,
    byCluster,
    vault,
    dryRun,
    yes,
    log,
    warn,
  });
  return {
    mode: "import-hardware",
    ...result,
  };
}
