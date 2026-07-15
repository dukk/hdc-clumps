import { join } from "node:path";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { clusterConfigByKey, isProxmoxConfigObject, loadProxmoxHostsByCluster } from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  proxmoxMaintainVerifyPaths,
} from "./proxmox-deploy-auth.mjs";
import {
  defaultUbuntuLtsReleaseFromConfig,
  lxcTemplateStorageFromConfig,
} from "./proxmox-provision-config.mjs";
import {
  syncUbuntuLtsTemplatesForCluster,
  ubuntuLtsMaintainPlanFromConfig,
} from "./proxmox-ubuntu-lts-sync.mjs";
import {
  DEFAULT_UBUNTU_LTS_RELEASE,
  lxcVolidForAppliance,
  ubuntuLtsByRelease,
} from "./ubuntu-lts-catalog.mjs";

export { applianceTemplateFromVolid, pveAuthFailureHint } from "./proxmox-lxc-templates.mjs";

/**
 * @param {unknown} cfg
 */
export function templatesPolicyFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return "ubuntu-lts";
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return "ubuntu-lts";
  const templates = provision.templates;
  if (isProxmoxConfigObject(templates) && templates.policy === "legacy") return "legacy";
  return "ubuntu-lts";
}

/**
 * @param {unknown} cfg
 */
export function provisionRequirementsFromConfig(cfg) {
  const policy = templatesPolicyFromConfig(cfg);
  const defaultRelease =
    policy === "ubuntu-lts" ? defaultUbuntuLtsReleaseFromConfig(cfg) : DEFAULT_UBUNTU_LTS_RELEASE;
  const entry = ubuntuLtsByRelease(defaultRelease);

  if (!isProxmoxConfigObject(cfg)) {
    return { lxcOstemplate: null, qemuTemplateVmid: null, defaultRelease };
  }
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) {
    return { lxcOstemplate: null, qemuTemplateVmid: null, defaultRelease };
  }

  const lxc = isProxmoxConfigObject(provision.lxc) ? provision.lxc : null;
  const qemu = isProxmoxConfigObject(provision.qemu) ? provision.qemu : null;

  let lxcOstemplate =
    lxc && typeof lxc.ostemplate === "string" && lxc.ostemplate.trim() ? lxc.ostemplate.trim() : null;
  if (!lxcOstemplate && entry) {
    lxcOstemplate = lxcVolidForAppliance(lxcTemplateStorageFromConfig(cfg), entry.lxcAppliance);
  }

  let qemuTemplateVmid = null;
  if (qemu && typeof qemu.template_vmid === "number" && Number.isFinite(qemu.template_vmid)) {
    qemuTemplateVmid = qemu.template_vmid;
  } else if (qemu && typeof qemu.template_vmid === "string" && /^\d+$/.test(qemu.template_vmid.trim())) {
    qemuTemplateVmid = Number(qemu.template_vmid.trim());
  } else if (entry) {
    qemuTemplateVmid = entry.qemuTemplateVmid;
  }

  return { lxcOstemplate, qemuTemplateVmid, defaultRelease };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} [opts.warn]
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @param {boolean} [opts.downloadMissing] Download missing LXC ostemplates via API (default true)
 * @param {boolean} [opts.buildQemuTemplate] Build missing QEMU templates from cloud images (default true)
 * @param {boolean} [opts.pruneUnsupported] Remove non-LTS Ubuntu templates (default true)
 * @param {boolean} [opts.dryRun] Report only; no download/build/prune
 * @returns {Promise<{ ok: boolean; checks: Record<string, unknown>[] }>}
 */
export async function runProxmoxMaintainTemplates(opts) {
  const {
    clumpRoot,
    log,
    warn = log,
    vault,
    downloadMissing = true,
    buildQemuTemplate = true,
    pruneUnsupported = true,
    dryRun = false,
  } = opts;
  const configRel = "clumps/infrastructure/proxmox/config.json";
  /** @type {{ data: Record<string, unknown>; path: string; source: string }} */
  let loaded;
  try {
    loaded = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: "clumps/infrastructure/proxmox/config.example.json",
    });
  } catch (e) {
    log(`Missing ${configRel} — copy config.example.json before maintain.`);
    return { ok: false, checks: [] };
  }
  const configPath = loaded.path;
  const cfg = loaded.data;

  const policy = templatesPolicyFromConfig(cfg);
  if (policy !== "ubuntu-lts") {
    warn('provision.templates.policy is "legacy" — set to "ubuntu-lts" (default) for multi-LTS maintain.');
    return { ok: true, checks: [] };
  }

  const plan = ubuntuLtsMaintainPlanFromConfig(cfg);
  if (!plan.entries.length) {
    log("No Ubuntu LTS entries in catalog — nothing to sync.");
    return { ok: true, checks: [] };
  }

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    log(`No hypervisors in ${configRel}.`);
    return { ok: false, checks: [] };
  }

  /** @type {Record<string, unknown>[]} */
  const checks = [];
  let ok = true;

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;
    const lead = members[0];
    const lxcStorage = lxcTemplateStorageFromConfig(cfg);
    log(`Cluster ${JSON.stringify(clusterKey)}: API via host ${JSON.stringify(lead.id)} …`);

    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn,
      log,
      configCluster: clusterConfigByKey(cfg, clusterKey),
      verifyPaths: proxmoxMaintainVerifyPaths(lead.pveNode, lxcStorage),
    });
    if (!auth) {
      ok = false;
      warn(
        `Skipping cluster ${JSON.stringify(clusterKey)} — no API token passed maintain checks on any host.`,
      );
      checks.push({ cluster: clusterKey, kind: "auth", ok: false });
      continue;
    }

    log(`Using API via host ${JSON.stringify(auth.host.id)}.`);

    const result = await syncUbuntuLtsTemplatesForCluster({
      clusterKey,
      members,
      apiBase: auth.host.apiBase,
      node: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      pveProfile: auth.pveProfile,
      cfg,
      downloadMissing,
      buildQemuTemplate,
      pruneUnsupported,
      dryRun,
      log,
      warn,
    });
    checks.push(...result.checks);
    if (!result.ok) ok = false;
  }

  if (ok) log("All Ubuntu LTS Proxmox templates are present.");
  else log("One or more template checks failed — see warnings above.");

  return { ok, checks };
}
