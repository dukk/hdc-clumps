import {
  downloadLxcApplianceTemplate,
  fetchVztmplVolidsOnNode,
  pveAuthFailureHint,
} from "./proxmox-lxc-templates.mjs";
import {
  defaultUbuntuLtsReleaseFromConfig,
  lxcTemplateStorageFromConfig,
  qemuBuildSpecForUbuntuLts,
} from "./proxmox-provision-config.mjs";
import {
  deleteLxcVztmpl,
  deleteQemuGuest,
  lxcVolidsToPrune,
  qemuTemplatesToPrune,
} from "./proxmox-template-prune.mjs";
import { ensureQemuCloudTemplate } from "./proxmox-qemu-template-build.mjs";
import { fetchClusterVmResources } from "./proxmox-host-provisioner.mjs";
import {
  lxcVolidForAppliance,
  UBUNTU_LTS_RELEASES,
} from "./ubuntu-lts-catalog.mjs";

export { defaultUbuntuLtsReleaseFromConfig, lxcTemplateStorageFromConfig, qemuBuildSpecForUbuntuLts };

/**
 * @param {unknown} cfg
 * @returns {{ lxcStorage: string; defaultRelease: string; entries: import("./ubuntu-lts-catalog.mjs").UbuntuLtsRelease[] }}
 */
export function ubuntuLtsMaintainPlanFromConfig(cfg) {
  return {
    lxcStorage: lxcTemplateStorageFromConfig(cfg),
    defaultRelease: defaultUbuntuLtsReleaseFromConfig(cfg),
    entries: UBUNTU_LTS_RELEASES,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.clusterKey
 * @param {{ pveNode: string; id: string }[]} opts.members
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {import("./pve-version.mjs").PveProfile} opts.pveProfile
 * @param {unknown} opts.cfg
 * @param {boolean} opts.downloadMissing
 * @param {boolean} opts.buildQemuTemplate
 * @param {boolean} opts.pruneUnsupported
 * @param {boolean} opts.dryRun
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @returns {Promise<{ ok: boolean; checks: Record<string, unknown>[] }>}
 */
export async function syncUbuntuLtsTemplatesForCluster(opts) {
  const {
    clusterKey,
    members,
    apiBase,
    node,
    authorization,
    rejectUnauthorized,
    pveProfile,
    cfg,
    downloadMissing,
    buildQemuTemplate,
    pruneUnsupported,
    dryRun,
    log,
    warn,
  } = opts;

  const plan = ubuntuLtsMaintainPlanFromConfig(cfg);
  /** @type {Record<string, unknown>[]} */
  const checks = [];
  let ok = true;

  log(
    `Ubuntu LTS template policy: ${plan.entries.map((e) => e.release).join(", ")} (vztmpl storage ${plan.lxcStorage}).`,
  );

  if (pruneUnsupported) {
    for (const m of members) {
      let volids = [];
      try {
        volids = await fetchVztmplVolidsOnNode(
          apiBase,
          m.pveNode,
          plan.lxcStorage,
          authorization,
          rejectUnauthorized,
        );
      } catch (e) {
        ok = false;
        const msg = /** @type {Error} */ (e).message || String(e);
        warn(`Cannot list vztmpl on ${m.pveNode} for prune: ${msg}${pveAuthFailureHint(msg)}`);
        continue;
      }
      const toRemove = lxcVolidsToPrune(volids);
      for (const volid of toRemove) {
        const appliance = volid.split("/").pop() ?? volid;
        if (dryRun) {
          log(`Would remove unsupported LXC template ${appliance} on ${m.pveNode}.`);
        } else {
          try {
            log(`Removing unsupported LXC template ${appliance} on ${m.pveNode} …`);
            await deleteLxcVztmpl(
              apiBase,
              m.pveNode,
              plan.lxcStorage,
              volid,
              authorization,
              rejectUnauthorized,
            );
          } catch (e) {
            ok = false;
            warn(`Failed to remove ${volid} on ${m.pveNode}: ${/** @type {Error} */ (e).message || e}`);
          }
        }
        checks.push({
          cluster: clusterKey,
          kind: "lxc-prune",
          node: m.pveNode,
          volid,
          ok: dryRun,
        });
      }
    }

    let resources = [];
    try {
      resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
    } catch (e) {
      ok = false;
      warn(`Cannot list cluster VMs for QEMU prune: ${/** @type {Error} */ (e).message || e}`);
    }
    if (resources.length || resources.length === 0) {
      const toRemove = qemuTemplatesToPrune(resources);
      for (const t of toRemove) {
        if (dryRun) {
          log(`Would remove unsupported QEMU template vmid ${t.vmid} (${t.name}) on ${t.node}.`);
        } else {
          try {
            log(`Removing unsupported QEMU template vmid ${t.vmid} (${t.name}) on ${t.node} …`);
            await deleteQemuGuest(apiBase, t.node, t.vmid, authorization, rejectUnauthorized);
          } catch (e) {
            ok = false;
            warn(`Failed to remove QEMU template ${t.vmid}: ${/** @type {Error} */ (e).message || e}`);
          }
        }
        checks.push({
          cluster: clusterKey,
          kind: "qemu-prune",
          vmid: t.vmid,
          name: t.name,
          node: t.node,
          ok: dryRun,
        });
      }
    }
  }

  for (const entry of plan.entries) {
    const volid = lxcVolidForAppliance(plan.lxcStorage, entry.lxcAppliance);
    for (const m of members) {
      log(`LXC ${entry.release}: checking ${entry.lxcAppliance} on ${m.pveNode} …`);
      let volids = [];
      try {
        volids = await fetchVztmplVolidsOnNode(
          apiBase,
          m.pveNode,
          plan.lxcStorage,
          authorization,
          rejectUnauthorized,
        );
      } catch (e) {
        ok = false;
        warn(
          `LXC ${entry.release}: failed to list vztmpl on ${m.pveNode}: ${/** @type {Error} */ (e).message || e}`,
        );
        checks.push({
          cluster: clusterKey,
          kind: "lxc",
          release: entry.release,
          node: m.pveNode,
          ok: false,
        });
        continue;
      }

      let found = volids.includes(volid);
      if (!found && downloadMissing && !dryRun) {
        try {
          await downloadLxcApplianceTemplate(
            apiBase,
            m.pveNode,
            plan.lxcStorage,
            entry.lxcAppliance,
            authorization,
            rejectUnauthorized,
            log,
            pveProfile,
          );
          volids = await fetchVztmplVolidsOnNode(
            apiBase,
            m.pveNode,
            plan.lxcStorage,
            authorization,
            rejectUnauthorized,
          );
          found = volids.includes(volid);
        } catch (e) {
          ok = false;
          warn(`LXC ${entry.release}: download failed on ${m.pveNode}: ${/** @type {Error} */ (e).message || e}`);
        }
      }
      if (!found) {
        ok = false;
        if (dryRun) {
          warn(`LXC ${entry.release}: would download ${entry.lxcAppliance} on ${m.pveNode}.`);
        } else {
          warn(`LXC ${entry.release}: missing ${volid} on ${m.pveNode}.`);
        }
      } else {
        log(`LXC ${entry.release}: OK on ${m.pveNode}.`);
      }
      checks.push({
        cluster: clusterKey,
        kind: "lxc",
        release: entry.release,
        node: m.pveNode,
        ostemplate: volid,
        ok: found,
      });
    }

    const buildSpec = qemuBuildSpecForUbuntuLts(cfg, entry);
    if (!buildSpec) continue;

    log(`QEMU ${entry.release}: checking template vmid ${entry.qemuTemplateVmid} …`);
    const buildResult = await ensureQemuCloudTemplate({
      apiBase,
      node,
      authorization,
      rejectUnauthorized,
      spec: buildSpec,
      dryRun,
      log,
      warn,
    });
    if (!buildResult.ok) ok = false;
    checks.push({
      cluster: clusterKey,
      kind: "qemu",
      release: entry.release,
      template_vmid: entry.qemuTemplateVmid,
      ok: buildResult.ok,
      built: buildResult.built,
    });
  }

  return { ok, checks };
}
