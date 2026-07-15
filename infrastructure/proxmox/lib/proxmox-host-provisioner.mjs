import {
  formatProxmoxStartupString,
  parseGuestBootOptions,
  parseStartupObject,
} from "./proxmox-guest-startup.mjs";
import { pveJsonRequest, pveData, pveDataArray } from "./pve-http.mjs";

/**
 * @param {unknown} row
 * @returns {row is Record<string, unknown>}
 */
function isObject(row) {
  return row !== null && typeof row === "object" && !Array.isArray(row);
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchClusterVmResources(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/resources?type=vm",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
}

/**
 * @param {Record<string, unknown>[]} resources
 * @param {number} vmid
 * @returns {{ node: string; name: string; template: boolean } | null}
 */
export function locateVmidInCluster(resources, vmid) {
  for (const r of resources) {
    if (typeof r.vmid !== "number" || r.vmid !== vmid) continue;
    const node = typeof r.node === "string" ? r.node.trim() : "";
    if (!node) continue;
    const name = typeof r.name === "string" ? r.name.trim() : `vmid-${vmid}`;
    return { node, name, template: isQemuTemplateFlag(r.template) };
  }
  return null;
}

/**
 * @param {Record<string, unknown>[]} resources
 * @returns {{ vmid: number; node: string; name: string }[]}
 */
/**
 * @param {unknown} row
 */
function isQemuTemplateFlag(row) {
  return row === 1 || row === true;
}

export function listQemuTemplates(resources) {
  /** @type {{ vmid: number; node: string; name: string }[]} */
  const out = [];
  for (const r of resources) {
    if (!isQemuTemplateFlag(r.template)) continue;
    if (typeof r.type === "string" && r.type !== "qemu") continue;
    if (typeof r.vmid !== "number") continue;
    const node = typeof r.node === "string" ? r.node.trim() : "";
    if (!node) continue;
    out.push({
      vmid: r.vmid,
      node,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : `vmid-${r.vmid}`,
    });
  }
  out.sort((a, b) => a.vmid - b.vmid);
  return out;
}

/**
 * @param {Record<string, unknown>[]} resources
 * @returns {{ vmid: number; node: string; name: string }[]}
 */
export function listQemuGuests(resources) {
  /** @type {{ vmid: number; node: string; name: string }[]} */
  const out = [];
  for (const r of resources) {
    if (isQemuTemplateFlag(r.template)) continue;
    if (typeof r.type === "string" && r.type !== "qemu") continue;
    if (typeof r.vmid !== "number") continue;
    const node = typeof r.node === "string" ? r.node.trim() : "";
    if (!node) continue;
    out.push({
      vmid: r.vmid,
      node,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : `vmid-${r.vmid}`,
    });
  }
  out.sort((a, b) => a.vmid - b.vmid);
  return out;
}

/**
 * @param {Record<string, unknown>[]} resources
 * @param {number} templateVmid
 * @param {string} [hostId] inventory host id for list-templates hint
 */
export function formatTemplateNotFoundMessage(resources, templateVmid, hostId = "hypervisor-a") {
  const templates = listQemuTemplates(resources);
  const guests = listQemuGuests(resources);
  const listCmd = `hdc run proxmox deploy -- list-templates --host ${hostId}`;

  if (!templates.length) {
    let msg =
      `No QEMU template with vmid ${templateVmid} in this cluster, and no QEMU templates were found. ` +
      `Create a VM in the Proxmox UI, install the OS, then right-click → Convert to template, ` +
      `or use create-container for LXC instead of create-vm.`;
    if (guests.length) {
      const lines = guests.map((g) => `  vmid ${g.vmid} on ${g.node} (${g.name})`).join("\n");
      msg += `\nQEMU guests (not templates) in cluster:\n${lines}`;
    }
    msg += `\nList templates after creating one: ${listCmd}`;
    return msg;
  }
  const lines = templates.map((t) => `  vmid ${t.vmid} on ${t.node} (${t.name})`).join("\n");
  return (
    `No guest with vmid ${templateVmid} in this cluster. QEMU templates present:\n${lines}\n` +
    `Re-run with --template-vmid <vmid>. List templates: ${listCmd}`
  );
}

/**
 * @param {Record<string, unknown>} p
 * @param {string} key
 */
function reqStr(p, key) {
  const v = p[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  throw new Error(`Missing or invalid Proxmox parameter ${JSON.stringify(key)}`);
}

/**
 * @param {Record<string, unknown>} p
 * @param {string} key
 */
function reqNum(p, key) {
  const v = p[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  throw new Error(`Missing or invalid Proxmox numeric parameter ${JSON.stringify(key)}`);
}

/**
 * @param {Record<string, string | number | boolean | undefined>} fields
 */
function formEncode(fields) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") u.set(k, v ? "1" : "0");
    else u.set(k, String(v));
  }
  return u.toString();
}

/**
 * @param {object} ctx
 * @param {string} ctx.apiBase
 * @param {string} ctx.pveNode
 * @param {string} ctx.authorization
 * @param {boolean} ctx.rejectUnauthorized
 * @returns {import("../../../lib/host-provisioner.mjs").HostProvisioner}
 */
export function createProxmoxHostProvisioner(ctx) {
  const { apiBase, pveNode, authorization, rejectUnauthorized, clumpId } = ctx;
  const hdcPackageId =
    typeof clumpId === "string" && clumpId.trim() ? clumpId.trim() : "";

  return {
    backendId: "proxmox",

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     * @param {import("../../../lib/host-provisioner.mjs").ContainerCreateSpec} spec
     */
    async createContainer(log, spec) {
      try {
        const p = /** @type {Record<string, unknown>} */ (spec.parameters ?? {});
        const vmid = reqNum(p, "vmid");
        const ostemplate = reqStr(p, "ostemplate");
        const storage = reqStr(p, "storage");
        const diskGb = spec.diskGb ?? reqNum(p, "rootfs_gb");
        const memoryMb = spec.memoryMb ?? reqNum(p, "memory_mb");
        const cores = spec.cores ?? reqNum(p, "cores");
        const bridge = typeof p.bridge === "string" && p.bridge.trim() ? p.bridge.trim() : "vmbr0";
        const ipConfig = typeof p.ip_config === "string" && p.ip_config.trim() ? p.ip_config.trim() : "dhcp";
        const net0 =
          typeof p.net0 === "string" && p.net0.trim()
            ? p.net0.trim()
            : `name=eth0,bridge=${bridge},ip=${ipConfig}`;
        const unprivileged =
          p.unprivileged === undefined ? 1 : Number(p.unprivileged) === 0 ? 0 : 1;
        const boot = parseGuestBootOptions(p);
        const onboot = boot?.onboot ?? (p.onboot === undefined ? 1 : Number(p.onboot) === 0 ? 0 : 1);
        const rootfs = typeof p.rootfs === "string" && p.rootfs.trim() ? p.rootfs.trim() : `${storage}:${diskGb}`;

        /** @type {Record<string, string | number | boolean | undefined>} */
        const body = {
          vmid,
          ostemplate,
          hostname: spec.name,
          memory: memoryMb,
          cores,
          net0,
          rootfs,
          onboot,
          unprivileged,
        };
        const startup =
          boot?.startup ??
          parseStartupObject(typeof p.startup === "object" ? p.startup : undefined);
        if (startup) {
          body.startup = formatProxmoxStartupString(startup);
        }
        if (typeof p.password === "string" && p.password) body.password = p.password;
        if (typeof p["ssh-public-keys"] === "string" && p["ssh-public-keys"].trim()) {
          body["ssh-public-keys"] = p["ssh-public-keys"].trim();
        }
        if (typeof p.nameserver === "string" && p.nameserver.trim()) body.nameserver = p.nameserver.trim();
        if (typeof p.searchdomain === "string" && p.searchdomain.trim()) body.searchdomain = p.searchdomain.trim();
        // API tokens cannot set feature flags on privileged CTs (root@pam only); apply via pct after create.
        const deferredFeatures =
          typeof p.features === "string" && p.features.trim() ? p.features.trim() : "";
        if (deferredFeatures && unprivileged !== 0) {
          body.features = deferredFeatures;
        } else if (deferredFeatures && unprivileged === 0) {
          log.info(
            `LXC ${vmid}: deferring features ${JSON.stringify(deferredFeatures)} (privileged CT — set via pct after create)`,
          );
        }

        const path = `/nodes/${encodeURIComponent(pveNode)}/lxc`;
        log.info(`POST ${path} (vmid ${vmid}, template ${ostemplate})`);
        const res = await pveJsonRequest(
          "POST",
          apiBase,
          path,
          authorization,
          rejectUnauthorized,
          formEncode(body),
        );
        const data = pveData(res);
        log.info("Proxmox accepted LXC create task.");
        return {
          ok: true,
          message: `LXC ${vmid} create requested on node ${pveNode}`,
          details: {
            vmid,
            node: pveNode,
            type: "lxc",
            task: data,
            ...(hdcPackageId ? { hdc_clump_id: hdcPackageId } : {}),
          },
        };
      } catch (e) {
        const msg = /** @type {Error} */ (e).message || String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     * @param {import("../../../lib/host-provisioner.mjs").VmCreateSpec} spec
     */
    async createVm(log, spec) {
      try {
        const p = /** @type {Record<string, unknown>} */ (spec.parameters ?? {});
        const templateVmid = spec.templateVmid ?? reqNum(p, "template_vmid");
        const newid = spec.vmid ?? reqNum(p, "vmid");
        const storage = typeof p.storage === "string" && p.storage.trim() ? p.storage.trim() : undefined;
        const full = Number(p.full) === 0 || p.full === false ? 0 : 1;
        const templateNodeOverride =
          typeof p.template_node === "string" && p.template_node.trim() ? p.template_node.trim() : "";

        log.info(`Resolving template vmid ${templateVmid} in cluster …`);
        const resources = await fetchClusterVmResources(apiBase, authorization, rejectUnauthorized);
        const located = locateVmidInCluster(resources, templateVmid);
        if (!located) {
          const msg = formatTemplateNotFoundMessage(resources, templateVmid, pveNode || "hypervisor-a");
          log.error(msg);
          return { ok: false, message: msg };
        }
        if (!located.template) {
          log.warn(
            `vmid ${templateVmid} on ${located.node} (${located.name}) is not marked as a template; clone may still work if it is stopped.`,
          );
        }
        const cloneNode = templateNodeOverride || located.node;
        if (cloneNode !== pveNode) {
          log.info(
            `Template vmid ${templateVmid} is on node ${located.node} (config --host maps to ${pveNode}); cloning via ${cloneNode}.`,
          );
        }

        /** @type {Record<string, string | number | boolean | undefined>} */
        const body = { newid, name: spec.name, full };
        if (storage) body.storage = storage;

        const path = `/nodes/${encodeURIComponent(cloneNode)}/qemu/${encodeURIComponent(String(templateVmid))}/clone`;
        log.info(`POST ${path} → newid ${newid} (full=${full})`);
        const res = await pveJsonRequest(
          "POST",
          apiBase,
          path,
          authorization,
          rejectUnauthorized,
          formEncode(body),
        );
        const data = pveData(res);
        log.info("Proxmox accepted QEMU clone task.");
        return {
          ok: true,
          message: `QEMU ${newid} clone from ${templateVmid} requested on node ${cloneNode}`,
          details: {
            vmid: newid,
            template_vmid: templateVmid,
            node: cloneNode,
            config_host_node: pveNode,
            type: "qemu",
            task: data,
            ...(hdcPackageId ? { hdc_clump_id: hdcPackageId } : {}),
          },
        };
      } catch (e) {
        const msg = /** @type {Error} */ (e).message || String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },
  };
}
