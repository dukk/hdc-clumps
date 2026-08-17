#!/usr/bin/env node
/**
 * Maintain Home Assistant OS QEMU VM (USB passthrough + HTTP health + managed automations).
 *
 * Usage: hdc run service homeassistant maintain -- [--instance a]
 *        [--reapply-usb] [--repair-boot-disk] [--fix-serial-console] [--repair-secure-boot]
 *        [--skip-http] [--skip-reverse-proxy] [--skip-automations] [--automation <id>] [--dry-run]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { applyQemuUsb } from "../../../infrastructure/proxmox/lib/proxmox-qemu-usb.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import {
  locateGuest,
  startQemuGuest,
} from "../../bind/lib/proxmox-qemu-redeploy.mjs";
import { resolvePveSshForHost } from "../../ollama/lib/ollama-install.mjs";

import { resolveHomeassistantDeployments } from "hdc/package/deployments.mjs";
import { createHaClient } from "hdc/package/ha-api.mjs";
import { resolveHaApiAuth } from "hdc/package/ha-api-auth.mjs";
import { syncManagedAutomations } from "hdc/package/ha-automations-sync.mjs";
import { forceStopHaosQemuGuest } from "hdc/package/haos-qemu-lifecycle.mjs";
import {
  repairHaosBootDisk,
  repairHaosEfiSecureBoot,
  repairHaosSerialConsole,
} from "hdc/package/proxmox-haos-vm.mjs";
import { probeHomeAssistantHttp } from "hdc/package/query-status.mjs";
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

/**
 * @param {ReturnType<typeof resolveHomeassistantDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {Record<string, unknown>} cfg
 */
async function maintainOne(deployment, flags, cfg) {
  const px = deployment.proxmox;
  const hostId = px.hostId;
  const q = px.qemu;
  const vmid = q.vmid;

  errout.write(`[hdc] ${target} ${verb}: ${deployment.systemId} on ${hostId} vmid ${vmid} …\n`);

  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });
  const located = await locateGuest(
    auth.host.apiBase,
    auth.authorization,
    auth.rejectUnauthorized,
    vmid,
  );
  if (!located) {
    return { ok: false, system_id: deployment.systemId, message: `vmid ${vmid} not found` };
  }

  const log = (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`);
  /** @type {Record<string, unknown>} */
  const extra = { vmid, node: located.node };

  const reapplyUsb = flagGet(flags, "reapply-usb") !== undefined;
  const repairBootDisk = flagGet(flags, "repair-boot-disk") !== undefined;
  const fixSerialConsole = flagGet(flags, "fix-serial-console") !== undefined;
  const repairSecureBoot = flagGet(flags, "repair-secure-boot") !== undefined;
  const usbOverride = flagGet(flags, "usb-id");
  const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);

  const forceStopOpts = {
    apiBase: auth.host.apiBase,
    authorization: auth.authorization,
    rejectUnauthorized: auth.rejectUnauthorized,
    node: located.node,
    vmid,
    sshUser: pveSsh.user,
    sshHost: pveSsh.host,
    log,
  };

  if (fixSerialConsole) {
    errout.write(`[hdc] ${target} ${verb}: stopping VM for serial-console repair …\n`);
    await forceStopHaosQemuGuest(forceStopOpts);
    const consoleRepair = await repairHaosSerialConsole({
      apiBase: auth.host.apiBase,
      node: located.node,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      vmid,
      log,
    });
    extra.serial_console_repair = consoleRepair;
    await startQemuGuest({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      log,
    });
  }

  if (repairSecureBoot) {
    errout.write(`[hdc] ${target} ${verb}: stopping VM for EFI Secure Boot repair …\n`);
    await forceStopHaosQemuGuest(forceStopOpts);
    const efiRepair = await repairHaosEfiSecureBoot({
      apiBase: auth.host.apiBase,
      node: located.node,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      vmid,
      storage: q.storage,
      log,
    });
    extra.efi_secure_boot_repair = efiRepair;
    await startQemuGuest({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      log,
    });
  }

  if (repairBootDisk) {
    errout.write(`[hdc] ${target} ${verb}: stopping VM for boot-disk repair …\n`);
    await forceStopHaosQemuGuest(forceStopOpts);
    const repair = await repairHaosBootDisk({
      apiBase: auth.host.apiBase,
      node: located.node,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      vmid,
      storage: q.storage,
      log,
    });
    extra.boot_disk_repair = repair;
    await startQemuGuest({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      log,
    });
  }

  if (reapplyUsb || usbOverride) {
    const usbDevices = await resolveUsbDevicesForDeploy({
      user: pveSsh.user,
      host: pveSsh.host,
      configured: q.usb,
      overrideId: usbOverride,
    });
    errout.write(`[hdc] ${target} ${verb}: stopping VM for USB update …\n`);
    await forceStopHaosQemuGuest(forceStopOpts);
    await applyQemuUsb({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      usb: usbDevices,
      sshUser: pveSsh.user,
      sshHost: pveSsh.host,
      log,
    });
    await startQemuGuest({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      node: located.node,
      vmid,
      log,
    });
    extra.usb = usbDevices.map((u) => u.id);
  }

  if (flagGet(flags, "skip-reverse-proxy") !== undefined) {
    log("--skip-reverse-proxy is a no-op (hdc no longer writes HA HTTP YAML)");
  }
  try {
    const reverseProxy = await maybeApplyHaosReverseProxyConfig({
      repoRoot: root,
      deployment,
      auth,
      node: located.node,
      sshUser: pveSsh.user,
      sshHost: pveSsh.host,
      dryRun: flagGet(flags, "dry-run") !== undefined,
      log,
    });
    extra.reverse_proxy = reverseProxy;
    if (reverseProxy.http && reverseProxy.http.ok === false) {
      errout.write(
        `[hdc] ${target} ${verb}: HTTP probe after HAOS YAML update failed — check HA logs.\n`,
      );
    }
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    errout.write(`[hdc] ${target} ${verb}: HAOS configuration.yaml update failed: ${msg}\n`);
    return { ok: false, system_id: deployment.systemId, message: msg, ...extra };
  }

  if (flagGet(flags, "skip-http") === undefined) {
    const ipHost = q.ip.split("/")[0];
    const probe = await probeHomeAssistantHttp(ipHost);
    extra.http = probe;
    if (!probe.ok) {
      errout.write(
        `[hdc] ${target} ${verb}: if the Proxmox console shows a serial boot hang, run with --fix-serial-console.\n`,
      );
      errout.write(
        `[hdc] ${target} ${verb}: if UEFI shows Access Denied on boot, run with --repair-secure-boot.\n`,
      );
      errout.write(
        `[hdc] ${target} ${verb}: HTTP probe failed — confirm static IP ${q.ip} in HA Settings → System → Network.\n`,
      );
    }
  }

  if (flagGet(flags, "skip-automations") === undefined) {
    const automations = Array.isArray(cfg.automations) ? cfg.automations : [];
    if (automations.length > 0) {
      try {
        const { baseUrl, token } = await resolveHaApiAuth({
          cfg,
          deployment,
          allowPrompt: false,
          log,
        });
        const client = createHaClient({ baseUrl, token });
        const automationFilter = flagGet(flags, "automation");
        const sync = await syncManagedAutomations({
          client,
          automations,
          dryRun: flagGet(flags, "dry-run") !== undefined,
          automationId: automationFilter,
          log,
        });
        extra.automations = sync;
        if (!sync.ok) {
          return {
            ok: false,
            system_id: deployment.systemId,
            message: "managed automation sync failed",
            ...extra,
          };
        }
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message || e);
        errout.write(`[hdc] ${target} ${verb}: automation sync failed: ${msg}\n`);
        return { ok: false, system_id: deployment.systemId, message: msg, ...extra };
      }
    }
  }

  return { ok: true, system_id: deployment.systemId, ...extra };
}

async function main() {
  const flags = parseArgvFlags(process.argv.slice(2));
  const cfg = ensurePackageConfig().data;

  errout.write(`[hdc] ${target} ${verb}: Home Assistant maintain.\n`);

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  try {
    const deployments = resolveHomeassistantDeployments(cfg, flags);
    for (const deployment of deployments) {
      try {
        const r = await maintainOne(deployment, flags, cfg);
        results.push(r);
        if (r.ok === false) ok = false;
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
