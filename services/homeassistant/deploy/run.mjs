#!/usr/bin/env node
/**
 * Deploy Home Assistant OS on Proxmox QEMU (HAOS OVA import + USB passthrough).
 *
 * Usage: hdc run service homeassistant deploy -- [--instance a | --system-id vm-homeassistant-a]
 *        [--destroy-existing] [--skip-provision] [--skip-existing | --redeploy-existing]
 *        [--usb-id vvvv:pppp] [--no-wait-http] [--skip-first-boot-restart] [--skip-reverse-proxy]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { fetchClusterVmResources } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { applyQemuUsb } from "../../../infrastructure/proxmox/lib/proxmox-qemu-usb.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  allocateNextVmid,
  locateGuest,
  startQemuGuest,
  stopAndDestroyQemu,
} from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";
import { promptExistingGuestAction } from "../../postgresql/lib/prompt-existing.mjs";

import { resolveHomeassistantDeployments } from "hdc/package/deployments.mjs";
import { maybeRestartHaosAfterFirstBoot } from "hdc/package/haos-first-boot.mjs";
import { provisionHaosQemuVm } from "hdc/package/proxmox-haos-vm.mjs";
import { ensureGuestPackageTag } from "../../../infrastructure/proxmox/lib/proxmox-guest-tags.mjs";
import { waitForHomeAssistantHttp } from "hdc/package/query-status.mjs";
import { maybeApplyHaosReverseProxyConfig } from "hdc/package/reverse-proxy-apply.mjs";
import { resolveUsbDevicesForDeploy } from "hdc/package/usb-preflight.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/homeassistant/config.example.json";
const root = repoRoot();
const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

function destroyPolicy(flags) {
  return flagGet(flags, "destroy-existing") !== undefined;
}

function skipProvision(flags) {
  return flagGet(flags, "skip-provision") !== undefined;
}

function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (destroyPolicy(flags)) return "destroy";
  return "prompt";
}

/**
 * @param {ReturnType<typeof resolveHomeassistantDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
async function deployOne(deployment, flags, log) {
  const inv = deployTargetInventory(root, target, { systemIdOverride: deployment.systemId });
  logDeployInventoryStatus(target, verb, inv);

  if (skipProvision(flags)) {
    errout.write(`[hdc] ${target} ${verb}: --skip-provision set � nothing to do.\n`);
    return { ok: true, system_id: deployment.systemId, skipped: true };
  }

  const px = deployment.proxmox;
  const hostId = px.hostId;
  const q = px.qemu;
  const net = px.network;

  errout.write(
    `[hdc] ${target} ${verb}: ${deployment.systemId} on ${hostId} (HAOS ${deployment.homeassistant.release}) �\n`,
  );

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const resources = await fetchClusterVmResources(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
  );

  let vmid = q.vmid;
  if (!Number.isFinite(vmid) || vmid <= 0) {
    vmid = allocateNextVmid(resources, 100);
    errout.write(`[hdc] ${target} ${verb}: auto-allocated vmid ${vmid}.\n`);
  }

  const located = await locateGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  const policy = existingGuestPolicy(flags);

  if (located) {
    let action = policy;
    if (policy === "prompt") {
      action = await promptExistingGuestAction(
        deployment.systemId,
        vmid,
        located.node,
        located.name,
      );
    }
    if (action === "skip") {
      errout.write(`[hdc] ${target} ${verb}: skipping ${deployment.systemId} (vmid ${vmid} exists).\n`);
      return { ok: true, system_id: deployment.systemId, skipped: true, vmid };
    }
    if (action === "destroy" || policy === "destroy") {
      await stopAndDestroyQemu({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    } else {
      return {
        ok: false,
        system_id: deployment.systemId,
        message: "guest exists � use --destroy-existing to rebuild",
        vmid,
      };
    }
  }

  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
  const usbOverride = flagGet(flags, "usb-id");
  errout.write(`[hdc] ${target} ${verb}: USB preflight on ${pveSsh.user}@${pveSsh.host} �\n`);
  const usbDevices = await resolveUsbDevicesForDeploy({
    user: pveSsh.user,
    host: pveSsh.host,
    configured: q.usb,
    overrideId: usbOverride,
  });
  errout.write(
    `[hdc] ${target} ${verb}: USB passthrough ${usbDevices.map((u) => u.id).join(", ")}.\n`,
  );

  const node = auth.host.pveNode;
  const bridge = q.bridge || net.bridge || "vmbr0";

  await provisionHaosQemuVm({
    apiBase: auth.host.apiBase,
    node,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    vmid,
    name: q.name,
    memoryMb: q.memoryMb,
    cores: q.cores,
    bridge,
    storage: q.storage,
    imageStorage: q.imageStorage,
    release: deployment.homeassistant.release,
    rootfsGb: q.rootfsGb,
    sshUser: pveSsh.user,
    sshHost: pveSsh.host,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  await ensureGuestPackageTag({
    guestType: "qemu",
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node,
    vmid,
    clumpId: target,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  if (usbDevices.length) {
    await applyQemuUsb({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node,
      vmid,
      usb: usbDevices,
      sshUser: pveSsh.user,
      sshHost: pveSsh.host,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
  }

  const logLine = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);

  await startQemuGuest({
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node,
    vmid,
    log: logLine,
  });

  const ipHost = q.ip.split("/")[0];
  /** @type {Record<string, unknown>} */
  const extra = { vmid, node, usb: usbDevices.map((u) => u.id), ip: q.ip };

  const firstBoot = await maybeRestartHaosAfterFirstBoot({
    host: ipHost,
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node,
    vmid,
    sshUser: pveSsh.user,
    sshHost: pveSsh.host,
    proxmoxPackageRoot: proxmoxRoot,
    flags,
    log: logLine,
  });
  extra.first_boot_restart = firstBoot.restarted;
  if (firstBoot.probe.ok) {
    extra.first_boot_http = firstBoot.probe;
  }

  if (flagGet(flags, "no-wait-http") === undefined) {
    errout.write(
      `[hdc] ${target} ${verb}: waiting for Home Assistant on http://${ipHost}:8123/ (first boot may take several minutes) �\n`,
    );
    if (net.gateway) {
      errout.write(
        `[hdc] ${target} ${verb}: if unreachable, set static IP ${q.ip} gw ${net.gateway} dns ${net.dns.join(",")} in HA Settings ? System ? Network.\n`,
      );
    }
    const httpWait = await waitForHomeAssistantHttp({
      host: ipHost,
      log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
    });
    extra.http_wait = httpWait;
    if (!httpWait.ok) {
      errout.write(
        `[hdc] ${target} ${verb}: if the Proxmox console shows a serial boot hang, run: hdc run service homeassistant maintain -- --fix-serial-console\n`,
      );
      errout.write(
        `[hdc] ${target} ${verb}: if UEFI shows Access Denied on boot, run: hdc run service homeassistant maintain -- --repair-secure-boot\n`,
      );
      errout.write(
        `[hdc] ${target} ${verb}: VM is up but HTTP probe failed � configure static IP ${q.ip} in HA Settings ? System ? Network, then run query --live.\n`,
      );
      return {
        ok: true,
        system_id: deployment.systemId,
        needs_static_ip: true,
        message: String(httpWait.error || "HTTP probe failed"),
        ...extra,
      };
    }
  }

  if (flagGet(flags, "skip-reverse-proxy") !== undefined) {
    logLine("--skip-reverse-proxy is a no-op (hdc no longer writes HA HTTP YAML)");
  }
  try {
    const reverseProxy = await maybeApplyHaosReverseProxyConfig({
      repoRoot: root,
      deployment,
      auth,
      node,
      sshUser: pveSsh.user,
      sshHost: pveSsh.host,
      log: logLine,
    });
    extra.reverse_proxy = reverseProxy;
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: HAOS configuration.yaml update failed: ${msg}\n`);
    return {
      ok: false,
      system_id: deployment.systemId,
      message: msg,
      ...extra,
    };
  }

  return {
    ok: true,
    system_id: deployment.systemId,
    host_id: hostId,
    hostname: deployment.hostname,
    release: deployment.homeassistant.release,
    public_url: deployment.homeassistant.publicUrl || null,
    ...extra,
  };
}

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const log = provisionLogFromConsole(console);
  const cfg = ensurePackageConfig().data;

  errout.write(`[hdc] ${target} ${verb}: Home Assistant OS QEMU deploy (stderr log; JSON on stdout).\n`);

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  try {
    const deployments = resolveHomeassistantDeployments(cfg, flags);
    for (const deployment of deployments) {
      try {
        const r = await deployOne(deployment, flags, log);
        results.push(r);
        if (!r.ok) ok = false;
      } catch (e) {
        ok = false;
        const msg = String(/** @type {Error} */ (e).message || e);
        errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} failed: ${msg}\n`);
        results.push({ ok: false, system_id: deployment.systemId, message: msg });
      }
    }
  } catch (e) {
    ok = false;
    errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).message || e}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const payload = { ok, target, verb, results };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });

  process.exitCode = ok ? 0 : 1;
}

main();
