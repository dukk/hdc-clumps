#!/usr/bin/env node
/**
 * Proxmox deploy — create LXC or clone QEMU guests via API (see `clumps/infrastructure/proxmox/config.json` + vault token).
 *
 * Usage (after `hdc run infrastructure proxmox deploy --`):
 *   create-container --host <inventory-id> --vmid <n> --hostname <name> [--package <service-id>] [--memory-mb N] [--cores N] [--reboot] …
 *   create-vm --host <id> --vmid <newid> --template-vmid <src> --name <guest-name> [--package <service-id>] [--memory-mb N] [--cores N] [--reboot] …
 *   list-templates --host <id>   (QEMU templates in the cluster — use vmid for --template-vmid)
 *
 * Defaults for LXC/QEMU sizing may come from `provision.lxc` / `provision.qemu` in config.json.
 * After template clone or LXC create, memory and cores are applied from flags or config; `--reboot` reboots a running guest.
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { stderr as errout } from "node:process";

import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet, flagNumber } from "hdc/package/parse-argv-flags.mjs";
import { authorizeProxmoxForHost } from "hdc/package/proxmox-deploy-auth.mjs";
import {
  createProxmoxHostProvisioner,
  fetchClusterVmResources,
  listQemuTemplates,
} from "hdc/package/proxmox-host-provisioner.mjs";
import { guestResourceOptsFromBlock } from "hdc/package/proxmox-guest-resources.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "hdc/package/proxmox-lxc-post-create.mjs";
import { waitForCloneTaskAndEnableAgent } from "hdc/package/proxmox-qemu-post-clone.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

/**
 * @param {string} path
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function provisionDefaults() {
  const p = join(clumpRoot, "config.json");
  if (!existsSync(p)) return { cfg: null, lxc: {}, qemu: {} };
  const c = readJson(p);
  const pr = c && typeof c.provision === "object" && c.provision ? c.provision : {};
  const lxc = pr && typeof pr.lxc === "object" && pr.lxc ? pr.lxc : {};
  const qemu = pr && typeof pr.qemu === "object" && pr.qemu ? pr.qemu : {};
  return { cfg: c, lxc, qemu };
}

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, string>} flags
 * @param {string} flagName
 * @param {string} objKey
 */
function pick(base, flags, flagName, objKey) {
  const f = flagGet(flags, flagName, objKey.replace(/_/g, "-"));
  if (f !== undefined) return f;
  const v = base[objKey];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

/**
 * @param {number | undefined} memoryMb
 * @param {number | undefined} cores
 * @param {Record<string, string>} flags
 * @param {unknown} [block]
 * @param {unknown} [proxmoxCfg]
 */
function resourceOptsFromSizing(memoryMb, cores, flags, block, proxmoxCfg) {
  if (block) {
    const fromBlock = guestResourceOptsFromBlock(block, flags, proxmoxCfg);
    if (fromBlock) return fromBlock;
  }
  if (memoryMb === undefined || cores === undefined) return undefined;
  return {
    memoryMb,
    cores,
    reboot: flagGet(flags, "reboot") !== undefined,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const flags = parseArgvFlags(argv.slice(1));
  const log = provisionLogFromConsole(console);

  errout.write(`[hdc] proxmox ${verb}: Proxmox API guest create (stderr log; JSON on stdout).\n`);

  const allowed = new Set(["create-container", "create-vm", "list-templates"]);
  if (!allowed.has(sub)) {
    errout.write(
      `[hdc] proxmox ${verb}: first arg must be create-container, create-vm, or list-templates.\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", message: "missing or invalid subcommand" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const hostId = flagGet(flags, "host");
  if (!hostId) {
    errout.write(`[hdc] proxmox ${verb}: required flag --host <inventory-hypervisor-id>\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", message: "missing --host" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  errout.write(`[hdc] proxmox ${verb}: resolving API token and endpoint for host ${JSON.stringify(hostId)} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot, hostId });
  if (auth.pveVersion) {
    errout.write(
      `[hdc] proxmox ${verb}: PVE ${auth.pveVersion.release} (${auth.pveProfile.id}) on ${JSON.stringify(auth.host.id)}.\n`,
    );
  }
  errout.write(
    auth.rejectUnauthorized
      ? `[hdc] proxmox ${verb}: TLS verify ON (use HDC_PROXMOX_TLS_INSECURE=1 if needed).\n`
      : `[hdc] proxmox ${verb}: TLS verify OFF (${auth.tlsInsecureLabel ?? "insecure"}).\n`,
  );

  if (sub === "list-templates") {
    const resources = await fetchClusterVmResources(
      auth.host.apiBase,
      auth.authorization,
      auth.rejectUnauthorized,
    );
    const templates = listQemuTemplates(resources);
    errout.write(`[hdc] proxmox ${verb}: ${templates.length} QEMU template(s) in cluster (API via ${auth.host.id}).\n`);
    for (const t of templates) {
      errout.write(`  vmid ${t.vmid}\tnode ${t.node}\t${t.name}\n`);
    }
    if (!templates.length) {
      errout.write(
        `[hdc] proxmox ${verb}: no QEMU templates found. Create a VM, install OS, then Convert to template in the UI.\n`,
      );
    }
    process.stdout.write(
      `${JSON.stringify(
        { ok: true, target: "proxmox", verb: "deploy", action: sub, host_id: hostId, templates },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const prov = createProxmoxHostProvisioner({
    apiBase: auth.host.apiBase,
    pveNode: auth.host.pveNode,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    clumpId: flagGet(flags, "package", "package-id", "clump_id") || undefined,
  });

  const { cfg: proxmoxCfg, lxc: defLxc, qemu: defQemu } = provisionDefaults();

  if (sub === "create-container") {
    const hostname = flagGet(flags, "hostname", "name");
    if (!hostname) {
      errout.write(`[hdc] proxmox ${verb}: create-container requires --hostname <dns-hostname>\n`);
      process.stdout.write(
        `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", action: sub, message: "missing --hostname" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const vmidStr = pick(defLxc, flags, "vmid", "vmid");
    const vmid = flagNumber(vmidStr, undefined);
    if (vmid === undefined) {
      errout.write(`[hdc] proxmox ${verb}: create-container requires --vmid <number> (or provision.lxc.vmid in config)\n`);
      process.stdout.write(
        `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", action: sub, message: "missing vmid" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const ostemplate = pick(defLxc, flags, "ostemplate", "ostemplate");
    const storage = pick(defLxc, flags, "storage", "storage");
    if (!ostemplate || !storage) {
      errout.write(
        `[hdc] proxmox ${verb}: create-container needs --ostemplate and --storage (or provision.lxc in config.json).\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", action: sub, message: "missing ostemplate or storage" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const rootGbStr = pick(defLxc, flags, "rootfs-gb", "rootfs_gb");
    const rootfsGb = flagNumber(rootGbStr, flagNumber(String(defLxc.rootfs_gb), undefined));
    if (rootfsGb === undefined) {
      errout.write(`[hdc] proxmox ${verb}: set --rootfs-gb or provision.lxc.rootfs_gb\n`);
      process.stdout.write(
        `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", action: sub, message: "missing rootfs_gb" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const memStr = pick(defLxc, flags, "memory-mb", "memory_mb");
    const memoryMb = flagNumber(memStr, flagNumber(String(defLxc.memory_mb), undefined));
    const coresStr = pick(defLxc, flags, "cores", "cores");
    const cores = flagNumber(coresStr, flagNumber(String(defLxc.cores), undefined));
    if (memoryMb === undefined || cores === undefined) {
      errout.write(`[hdc] proxmox ${verb}: set --memory-mb / --cores or provision.lxc.memory_mb / provision.lxc.cores\n`);
      process.stdout.write(
        `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", action: sub, message: "missing memory or cores" }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }

    /** @type {Record<string, unknown>} */
    const parameters = {
      vmid,
      ostemplate,
      storage,
      rootfs_gb: rootfsGb,
      memory_mb: memoryMb,
      cores,
    };
    const bridge = pick(defLxc, flags, "bridge", "bridge");
    if (bridge) parameters.bridge = bridge;
    const ipCfg = pick(defLxc, flags, "ip-config", "ip_config");
    if (ipCfg) parameters.ip_config = ipCfg;
    const net0 = flagGet(flags, "net0");
    if (net0) parameters.net0 = net0;
    const pw = flagGet(flags, "password");
    if (pw) parameters.password = pw;
    const sshKeys = flagGet(flags, "ssh-public-keys", "ssh_public_keys");
    if (sshKeys) parameters["ssh-public-keys"] = sshKeys;
    const rootfs = flagGet(flags, "rootfs");
    if (rootfs) parameters.rootfs = rootfs;
    if (defLxc.unprivileged !== undefined) parameters.unprivileged = defLxc.unprivileged;
    if (defLxc.onboot !== undefined) parameters.onboot = defLxc.onboot;
    if (defLxc.startup !== undefined) parameters.startup = defLxc.startup;

    const result = await prov.createContainer(log, {
      name: hostname,
      memoryMb,
      cores,
      diskGb: rootfsGb,
      parameters,
    });

    if (result.ok) {
      const logLine = (line) => errout.write(`[hdc] proxmox ${verb}: ${line}\n`);
      await waitForLxcCreateTaskAndApplyResources(
        result,
        auth,
        vmid,
        logLine,
        resourceOptsFromSizing(memoryMb, cores, flags, defLxc, proxmoxCfg),
      );
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          target: "proxmox",
          verb: "deploy",
          action: sub,
          host_id: hostId,
          pve_node: auth.host.pveNode,
          result,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  /* create-vm */
  const name = flagGet(flags, "name", "guest-name");
  if (!name) {
    errout.write(`[hdc] proxmox ${verb}: create-vm requires --name <guest-name>\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", action: sub, message: "missing --name" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const newIdStr = pick(defQemu, flags, "vmid", "vmid");
  const newid = flagNumber(newIdStr, undefined);
  const tmplStr = pick(defQemu, flags, "template-vmid", "template_vmid");
  const templateVmid = flagNumber(tmplStr, flagNumber(String(defQemu.template_vmid), undefined));
  if (newid === undefined || templateVmid === undefined) {
    errout.write(
      `[hdc] proxmox ${verb}: create-vm needs --vmid <newid> and --template-vmid <source> (or provision.qemu in config).\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", action: sub, message: "missing vmid or template_vmid" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const memStr = pick(defQemu, flags, "memory-mb", "memory_mb");
  const memoryMb = flagNumber(memStr, flagNumber(String(defQemu.memory_mb), undefined));
  const coresStr = pick(defQemu, flags, "cores", "cores");
  const cores = flagNumber(coresStr, flagNumber(String(defQemu.cores), undefined));

  /** @type {Record<string, unknown>} */
  const parameters = { vmid: newid, template_vmid: templateVmid };
  const st = pick(defQemu, flags, "storage", "storage");
  if (st) parameters.storage = st;
  if (flags.full === "0" || flags.full === "false") parameters.full = false;
  if (defQemu.onboot !== undefined) parameters.onboot = defQemu.onboot;
  if (defQemu.startup !== undefined) parameters.startup = defQemu.startup;

  const result = await prov.createVm(log, {
    name,
    vmid: newid,
    templateVmid,
    memoryMb,
    cores,
    parameters,
  });

  if (result.ok) {
    const logLine = (line) => errout.write(`[hdc] proxmox ${verb}: ${line}\n`);
    await waitForCloneTaskAndEnableAgent(
      result,
      auth,
      newid,
      logLine,
      resourceOptsFromSizing(memoryMb, cores, flags, defQemu, proxmoxCfg),
    );
  }

  if (!result.ok) {
    errout.write(
      `[hdc] proxmox ${verb}: ${result.message}\n` +
        `[hdc] proxmox ${verb}: discover templates: hdc run proxmox deploy -- list-templates --host ${hostId}\n`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.ok,
        target: "proxmox",
        verb: "deploy",
        action: sub,
        host_id: hostId,
        pve_node: auth.host.pveNode,
        result,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] proxmox ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target: "proxmox", verb: "deploy", message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
