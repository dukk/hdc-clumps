import { spawnSync } from "node:child_process";
import { stderr as errout } from "node:process";

import { loadManualSystemSidecar, primaryIpFromSystem } from "hdc/package/inventory-sidecar.mjs";
import { sshRemote } from "hdc/package/pve-pct-remote.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import {
  authorizeProxmoxForClusterMembers,
  PROXMOX_MAINTAIN_VERIFY_PATHS,
} from "./proxmox-deploy-auth.mjs";
import {
  fetchClusterVmResources,
  locateVmidInCluster,
  listQemuTemplates,
} from "./proxmox-host-provisioner.mjs";
import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import {
  isProxmoxConfigObject,
  loadProxmoxHostsByCluster,
  resolveProxmoxHost,
  clusterConfigByKey,
} from "./proxmox-config.mjs";
import { resolvePveSshForHost } from "./proxmox-pve-ssh.mjs";
import { pveData, pveJsonRequest } from "./pve-http.mjs";

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[proxmox] query: ${line}\n`);
}

/**
 * @param {Record<string, unknown>[]} resources
 * @param {number} vmid
 * @returns {{ node: string; name: string; template: boolean; type: string; status?: string; resource: Record<string, unknown> } | null}
 */
export function locateGuestResource(resources, vmid) {
  for (const r of resources) {
    if (typeof r.vmid !== "number" || r.vmid !== vmid) continue;
    const node = typeof r.node === "string" ? r.node.trim() : "";
    if (!node) continue;
    const typ = typeof r.type === "string" ? r.type : "qemu";
    return {
      node,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : `vmid-${vmid}`,
      template: r.template === 1 || r.template === true,
      type: typ,
      status: typeof r.status === "string" ? r.status : undefined,
      resource: r,
    };
  }
  return null;
}

/**
 * Resolve a guest selector: numeric VMID or inventory system id (reads proxmox.vmid / access).
 * @param {string} selector
 * @param {string} root
 * @returns {{ vmid: number; system_id?: string; ip?: string | null }}
 */
export function resolveGuestSelector(selector, root) {
  const s = String(selector ?? "").trim();
  if (!s) throw new Error("--guest requires a vmid or system-id");
  if (/^\d+$/.test(s)) {
    return { vmid: Number(s) };
  }
  const sidecar = loadManualSystemSidecar(root, s);
  if (!sidecar) {
    throw new Error(`No inventory/manual/systems/${s}.json for --guest ${JSON.stringify(s)}`);
  }
  const px = isProxmoxConfigObject(sidecar.proxmox) ? sidecar.proxmox : null;
  let vmid =
    px && typeof px.vmid === "number"
      ? px.vmid
      : px && typeof px.vmid === "string" && /^\d+$/.test(px.vmid.trim())
        ? Number(px.vmid.trim())
        : null;
  if (vmid == null && isProxmoxConfigObject(sidecar.virtual_hardware)) {
    const vh = sidecar.virtual_hardware;
    if (typeof vh.vmid === "number") vmid = vh.vmid;
  }
  if (vmid == null || !Number.isFinite(vmid)) {
    throw new Error(`System ${JSON.stringify(s)} has no proxmox.vmid in inventory`);
  }
  return { vmid: Math.floor(vmid), system_id: s, ip: primaryIpFromSystem(sidecar) };
}

/**
 * @param {string} clumpRoot
 * @param {import("hdc/cli/lib/vault-access.mjs").VaultAccess} vault
 */
async function authorizeLead(clumpRoot, vault) {
  const loaded = loadProxmoxPackageConfig(clumpRoot);
  const cfg = loaded.data;
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath: loaded.path,
    configRel: "clumps/infrastructure/proxmox/config.json",
    onSkip: (id, reason) => log(`skip ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    throw new Error("No Proxmox hosts in config");
  }
  /** @type {{ apiBase: string; authorization: string; rejectUnauthorized: boolean; byCluster: Map<string, import("./proxmox-config.mjs").ProxmoxClusterMember[]>; cfg: unknown } | null} */
  let first = null;
  for (const ck of clusterKeys) {
    const members = byCluster.get(ck);
    if (!members?.length) continue;
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn: (m) => log(`WARN ${m}`),
      verifyPaths: PROXMOX_MAINTAIN_VERIFY_PATHS,
      configCluster: clusterConfigByKey(cfg, ck),
      log,
    });
    if (!auth) continue;
    if (!first) {
      first = {
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        byCluster,
        cfg,
      };
    }
  }
  if (!first) throw new Error("Could not authorize any Proxmox API endpoint");
  return first;
}

/**
 * Map pve_node → config host id.
 * @param {Map<string, import("./proxmox-config.mjs").ProxmoxClusterMember[]>} byCluster
 */
function pveNodeToHostId(byCluster) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const members of byCluster.values()) {
    for (const m of members) {
      map.set(m.pveNode, m.id);
    }
  }
  return map;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} opts.guestSelector
 * @param {string} [opts.repoRootPath]
 */
export async function runGuestDiag(opts) {
  const root = opts.repoRootPath ?? repoRoot();
  const deps = createNodeCliDeps();
  const vault = createVaultAccess(vaultDepsFromCli(deps));
  const auth = await authorizeLead(opts.clumpRoot, vault);
  const guest = resolveGuestSelector(opts.guestSelector, root);
  const resources = await fetchClusterVmResources(
    auth.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );
  const located = locateGuestResource(resources, guest.vmid);
  if (!located) {
    return {
      ok: false,
      mode: "guest",
      vmid: guest.vmid,
      system_id: guest.system_id ?? null,
      message: `vmid ${guest.vmid} not found in cluster resources`,
    };
  }
  const nodeMap = pveNodeToHostId(auth.byCluster);
  const hostId = nodeMap.get(located.node) ?? null;
  /** @type {Record<string, unknown>} */
  const out = {
    ok: true,
    mode: "guest",
    vmid: guest.vmid,
    system_id: guest.system_id ?? null,
    name: located.name,
    type: located.type,
    template: located.template,
    node: located.node,
    host_id: hostId,
    status: located.status ?? null,
    resource: located.resource,
  };

  if (hostId) {
    try {
      const ssh = resolvePveSshForHost(opts.clumpRoot, hostId);
      const kind = located.type === "lxc" ? "pct" : "qm";
      const statusR = sshRemote(ssh.user, ssh.host, `${kind} status ${guest.vmid}`, { capture: true });
      out.cli_status = {
        ok: statusR.status === 0,
        stdout: (statusR.stdout || "").trim(),
        stderr: (statusR.stderr || "").trim(),
      };
      if (located.type !== "lxc") {
        const pingR = sshRemote(ssh.user, ssh.host, `qm guest cmd ${guest.vmid} ping 2>&1 || true`, {
          capture: true,
        });
        out.guest_agent_ping = {
          ok: pingR.status === 0 && !/error|failed|not running/i.test(`${pingR.stdout}${pingR.stderr}`),
          stdout: (pingR.stdout || "").trim(),
          stderr: (pingR.stderr || "").trim(),
        };
      }
    } catch (e) {
      out.ssh_error = String(/** @type {Error} */ (e).message || e);
    }
  }

  let ip = guest.ip ?? null;
  if (!ip && located.type !== "lxc" && hostId) {
    try {
      const body = await pveJsonRequest(
        "GET",
        auth.apiBase,
        `/nodes/${encodeURIComponent(located.node)}/qemu/${guest.vmid}/agent/network-get-interfaces`,
        auth.authorization,
        auth.rejectUnauthorized,
        undefined,
      );
      const data = pveData(body);
      const ifaces = Array.isArray(data) ? data : isProxmoxConfigObject(data) && Array.isArray(data.result) ? data.result : [];
      for (const iface of ifaces) {
        if (!isProxmoxConfigObject(iface)) continue;
        const addrs = Array.isArray(iface["ip-addresses"]) ? iface["ip-addresses"] : [];
        for (const a of addrs) {
          if (!isProxmoxConfigObject(a)) continue;
          if (a["ip-address-type"] !== "ipv4") continue;
          const addr = typeof a["ip-address"] === "string" ? a["ip-address"].trim() : "";
          if (addr && !addr.startsWith("127.")) {
            ip = addr;
            break;
          }
        }
        if (ip) break;
      }
    } catch {
      /* agent may be down */
    }
  }
  out.ip = ip;

  if (ip) {
    const icmp = spawnSync("ping", process.platform === "win32" ? ["-n", "2", "-w", "2000", ip] : ["-c", "2", "-W", "2", ip], {
      encoding: "utf8",
    });
    out.icmp = {
      ok: icmp.status === 0,
      status: icmp.status,
      stdout: (icmp.stdout || "").trim().slice(0, 500),
    };
    const sshProbe = spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", `root@${ip}`, "true"],
      { encoding: "utf8" },
    );
    out.ssh = {
      ok: sshProbe.status === 0,
      status: sshProbe.status,
      stderr: (sshProbe.stderr || "").trim().slice(0, 300),
    };
  }

  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {number} opts.templateVmid
 */
export async function runFindTemplate(opts) {
  const deps = createNodeCliDeps();
  const vault = createVaultAccess(vaultDepsFromCli(deps));
  const auth = await authorizeLead(opts.clumpRoot, vault);
  const resources = await fetchClusterVmResources(
    auth.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );
  const templates = listQemuTemplates(resources);
  const matches = templates.filter((t) => t.vmid === opts.templateVmid);
  const located = locateVmidInCluster(resources, opts.templateVmid);
  const nodeMap = pveNodeToHostId(auth.byCluster);
  return {
    ok: matches.length > 0 || (located?.template === true),
    mode: "find-template",
    template_vmid: opts.templateVmid,
    matches: matches.map((t) => ({
      ...t,
      host_id: nodeMap.get(t.node) ?? null,
    })),
    located: located
      ? {
          ...located,
          host_id: nodeMap.get(located.node) ?? null,
        }
      : null,
    all_templates: templates.map((t) => ({
      ...t,
      host_id: nodeMap.get(t.node) ?? null,
    })),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} opts.hostId
 */
export async function runHostCapacity(opts) {
  const loaded = loadProxmoxPackageConfig(opts.clumpRoot);
  const hostRec = resolveProxmoxHost(loaded.data, opts.hostId);
  if (!hostRec) {
    return {
      ok: false,
      mode: "host-capacity",
      host_id: opts.hostId,
      message: `Unknown or down Proxmox host ${JSON.stringify(opts.hostId)}`,
    };
  }
  const ssh = resolvePveSshForHost(opts.clumpRoot, opts.hostId);
  const cmds = {
    free: "free -h",
    df: "df -hT / /var/lib/vz 2>/dev/null; pvesm status 2>/dev/null | head -40",
    qm_list: "qm list",
    pct_list: "pct list",
  };
  /** @type {Record<string, { ok: boolean; stdout: string; stderr: string }>} */
  const results = {};
  for (const [key, cmd] of Object.entries(cmds)) {
    const r = sshRemote(ssh.user, ssh.host, cmd, { capture: true });
    results[key] = {
      ok: r.status === 0,
      stdout: (r.stdout || "").trim(),
      stderr: (r.stderr || "").trim(),
    };
  }
  return {
    ok: true,
    mode: "host-capacity",
    host_id: opts.hostId,
    pve_node: hostRec.pveNode,
    ssh_host: ssh.host,
    ...results,
  };
}

/**
 * @param {string[]} argv
 * @param {string} clumpRoot
 * @returns {Promise<object | null>} Payload if a diag mode was selected, else null
 */
export async function maybeRunProxmoxQueryDiag(argv, clumpRoot) {
  const flags = parseArgvFlags(argv);
  const guest = flagGet(flags, "guest");
  const findTemplate = flagGet(flags, "find-template", "find_template");
  const hostCapacity = flagGet(flags, "host-capacity", "host_capacity");
  if (!guest && !findTemplate && !hostCapacity) return null;

  if (guest) {
    log(`guest diag for ${JSON.stringify(guest)} …`);
    return runGuestDiag({ clumpRoot, guestSelector: guest });
  }
  if (findTemplate) {
    const n = Number(findTemplate);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--find-template requires a numeric vmid");
    }
    log(`find template vmid ${n} …`);
    return runFindTemplate({ clumpRoot, templateVmid: Math.floor(n) });
  }
  log(`host capacity for ${JSON.stringify(hostCapacity)} …`);
  return runHostCapacity({ clumpRoot, hostId: String(hostCapacity) });
}
