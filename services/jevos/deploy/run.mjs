#!/usr/bin/env node
/**
 * Deploy jevos (`jev serve`, OpenVINO INT8 model) on a Proxmox LXC (multi-instance deployments[]).
 *
 * Usage: hdc run service jevos deploy -- [--instance a | --system-id jevos-a]
 *        hdc run service jevos deploy -- [--skip-install] [--destroy-existing | --skip-existing | --redeploy-existing]
 *
 * Mirrors services/llama-cpp LXC path: proxmox lxc create via API → resources → install via `pct exec`.
 * API key: vault `server.api_key_vault_key` (default HDC_JEVOS_API_KEY), generated when missing.
 */
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { deployTargetInventory, logDeployInventoryStatus } from "hdc/package/deploy-inventory.mjs";
import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { runOperationReportTail } from "hdc/package/operation-report.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { createProxmoxHostProvisioner } from "../../../infrastructure/proxmox/lib/proxmox-host-provisioner.mjs";
import { guestResourceOptsFromBlock } from "../../../infrastructure/proxmox/lib/proxmox-guest-resources.mjs";
import { waitForLxcCreateTaskAndApplyResources } from "../../../infrastructure/proxmox/lib/proxmox-lxc-post-create.mjs";
import { resolveProvisionVmid } from "../../../infrastructure/proxmox/lib/proxmox-vmid-conflict.mjs";
import { resolvePveSshForHost } from "../../../infrastructure/proxmox/lib/proxmox-pve-ssh.mjs";
import { stopAndDestroyLxc } from "../../../infrastructure/proxmox/lib/proxmox-guest-destroy.mjs";
import { findClusterGuest } from "../../ollama/lib/guest-exists.mjs";
import { resolveLxcRootPassword } from "../../ollama/lib/lxc-password.mjs";
import { promptExistingGuestAction } from "../../ollama/lib/prompt-existing.mjs";
import { waitForLlamaCppProvisionTask } from "../../llama-cpp/lib/proxmox-task-wait.mjs";

import { apiKeyVaultKey, guestIpFromLxc, resolveJevosDeployments, serverPort } from "../lib/deployments.mjs";
import { installJevosInCt } from "../lib/jevos-install.mjs";
import { probeJevos } from "../lib/jevos-http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");
const CLUMP_CONFIG_EXAMPLE = "clumps/services/jevos/config.example.json";
const root = repoRoot();

/** @type {{ data: Record<string, unknown>; path: string; source: string } | null} */
let _pkgConfig = null;
function ensurePackageConfig() {
  if (!_pkgConfig) {
    _pkgConfig = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: CLUMP_CONFIG_EXAMPLE });
  }
  return _pkgConfig;
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {Record<string, string>} flags */
function existingGuestPolicy(flags) {
  if (flagGet(flags, "skip-existing") !== undefined) return "skip";
  if (flagGet(flags, "redeploy-existing") !== undefined) return "redeploy";
  if (flagGet(flags, "destroy-existing", "destroy_existing") !== undefined) return "destroy";
  return "prompt";
}

/** Local ~/.ssh/*.pub lines → root authorized_keys in the new CT. */
function localSshPublicKeys() {
  const dir = join(homedir(), ".ssh");
  /** @type {string[]} */
  const out = [];
  for (const name of ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const line = readFileSync(p, "utf8").trim().split(/\r?\n/)[0] ?? "";
    if (/^(ssh-|ecdsa-)/.test(line)) out.push(line);
  }
  return out.join("\n");
}

/**
 * @param {ReturnType<typeof createPackageVaultAccess>} vault
 * @param {string} key
 */
async function ensureApiKey(vault, key) {
  const stored = String((await vault.getSecret(key, { optional: true })) ?? "").trim();
  if (stored && stored !== "undefined" && stored !== "null") return { value: stored, generated: false };
  const value = randomBytes(32).toString("base64url");
  await vault.setSecret(key, value);
  errout.write(`[hdc] ${target} ${verb}: generated new API key and stored it in vault ${key}.\n`);
  return { value, generated: true };
}

/**
 * @param {ReturnType<typeof resolveJevosDeployments>[number]} deployment
 * @param {Record<string, string>} flags
 * @param {import("hdc/package/host-provisioner.mjs").ProvisionLog} log
 * @param {{ vault: ReturnType<typeof createPackageVaultAccess>; ctPasswordCache: { value: string | null } }} ctx
 */
async function deployOne(deployment, flags, log, ctx) {
  const { systemId, proxmox: px, install, server } = deployment;
  const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
  const inv = deployTargetInventory(root, target, { systemIdOverride: systemId });
  logDeployInventoryStatus(target, verb, inv);

  const hostId = String(px.host_id).trim();
  const lxc = isObject(px.lxc) ? px.lxc : {};
  const vmid = Number(lxc.vmid);
  errout.write(`[hdc] ${target} ${verb}: ${systemId} (vmid ${vmid}) on ${hostId} …\n`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: proxmoxRoot, hostId });

  const located = await findClusterGuest(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, vmid);
  let skipProvision = false;
  if (located) {
    let action = existingGuestPolicy(flags);
    if (action === "prompt") action = await promptExistingGuestAction(systemId, vmid, located.node, located.name);
    if (action === "skip") {
      return { ok: true, system_id: systemId, host_id: hostId, skipped: true, message: "guest already exists" };
    }
    if (action === "destroy") {
      errout.write(`[hdc] ${target} ${verb}: destroying existing vmid ${vmid} on ${located.node} …\n`);
      await stopAndDestroyLxc({
        apiBase: auth.host.apiBase,
        authorization: auth.authorization,
        rejectUnauthorized: auth.rejectUnauthorized,
        node: located.node,
        vmid,
        log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
      });
    } else {
      errout.write(`[hdc] ${target} ${verb}: vmid ${vmid} exists — redeploy (install only).\n`);
      skipProvision = true;
    }
  }

  /** @type {any} */
  let provisionResult;
  if (!skipProvision) {
    const prov = createProxmoxHostProvisioner({
      apiBase: auth.host.apiBase,
      pveNode: auth.host.pveNode,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
    });
    const hostname = (typeof lxc.hostname === "string" && lxc.hostname.trim()) || systemId;
    // Vault HDC_PROXMOX_LXC_ROOT_PASSWORD is mapped to the proxmox clump env only; read it here so non-TTY deploys work.
    const vaultRootPw = String((await ctx.vault.getSecret("HDC_PROXMOX_LXC_ROOT_PASSWORD", { optional: true })) ?? "").trim();
    const pwSource = vaultRootPw && vaultRootPw !== "undefined" && !lxc.password ? { ...lxc, password: vaultRootPw } : lxc;
    const rootPassword = await resolveLxcRootPassword(systemId, vmid, pwSource, flags, {
      cached: ctx.ctPasswordCache.value,
      setCached: (v) => {
        ctx.ctPasswordCache.value = v;
      },
    });
    /** @type {Record<string, unknown>} */
    const parameters = { ...lxc, password: rootPassword };
    const keys = localSshPublicKeys();
    if (keys && !parameters["ssh-public-keys"]) parameters["ssh-public-keys"] = keys;
    provisionResult = await prov.createContainer(log, {
      name: hostname,
      memoryMb: Number(lxc.memory_mb),
      cores: Number(lxc.cores),
      diskGb: Number(lxc.rootfs_gb),
      parameters,
    });
    if (!provisionResult.ok) {
      return { ok: false, system_id: systemId, host_id: hostId, result: provisionResult };
    }
    await waitForLlamaCppProvisionTask(provisionResult, auth, systemId, resolveProvisionVmid(provisionResult, vmid));
  } else {
    provisionResult = {
      ok: true,
      message: `LXC ${vmid} already present on ${located?.node}`,
      details: { vmid, node: located?.node, type: "lxc", skipped_provision: true },
    };
  }

  const guestVmid = resolveProvisionVmid(provisionResult, vmid);
  await waitForLxcCreateTaskAndApplyResources(
    provisionResult,
    auth,
    vmid,
    (line) => errout.write(`[hdc] ${target} ${verb}: ${systemId}: ${line}\n`),
    guestResourceOptsFromBlock(lxc, flags),
  );

  /** @type {Record<string, unknown> | null} */
  let installResult = null;
  /** @type {Record<string, unknown> | null} */
  let probe = null;
  const keyName = apiKeyVaultKey(server);
  if (install.enabled !== false) {
    const apiKey = await ensureApiKey(ctx.vault, keyName);
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    installResult = await installJevosInCt({
      user: pveSsh.user,
      pveHost: pveSsh.host,
      vmid: guestVmid,
      install,
      server,
      apiKey: apiKey.value,
      cpuset: typeof lxc.cpuset === "string" && lxc.cpuset.trim() ? lxc.cpuset.trim() : null,
    });
    const ip = guestIpFromLxc(lxc);
    if (installResult.ok && ip) {
      probe = await probeJevos(`http://${ip}:${serverPort(server)}`, { apiKey: apiKey.value, timeoutMs: 15_000 });
      errout.write(`[hdc] ${target} ${verb}: probe ${JSON.stringify(probe)}\n`);
    }
  } else {
    installResult = { ok: true, message: "skipped" };
  }

  const ok = provisionResult.ok && Boolean(installResult?.ok) && (probe ? probe.ok === true : true);
  return {
    ok,
    system_id: systemId,
    host_id: hostId,
    vmid: guestVmid,
    redeploy: skipProvision,
    api_key_vault_key: keyName,
    result: provisionResult,
    install: installResult,
    probe,
  };
}

async function main() {
  errout.write(`[hdc] ${target} ${verb}: jevos via Proxmox LXC (stderr log; JSON on stdout).\n`);
  if (!existsSync(ensurePackageConfig().path)) {
    const inv = deployTargetInventory(root, target);
    logDeployInventoryStatus(target, verb, inv);
    process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: "clump config missing" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const flags = parseArgvFlags(process.argv.slice(2));
  const deployments = resolveJevosDeployments(ensurePackageConfig().data, flags);
  const vault = createPackageVaultAccess();
  await vault.unlock({});
  const log = provisionLogFromConsole(console);
  const ctx = { vault, ctPasswordCache: { value: null } };
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const d of deployments) {
    try {
      results.push(await deployOne(d, flags, log, ctx));
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message || e);
      errout.write(`[hdc] ${target} ${verb}: ${d.systemId} failed: ${msg}\n`);
      results.push({ ok: false, system_id: d.systemId, message: msg });
    }
  }
  const ok = results.every((r) => r.ok);
  const payload = { ok, target, verb, count: results.length, results };
  runOperationReportTail({
    clumpRoot,
    repoRoot: root,
    verb,
    argv: process.argv.slice(2),
    payload,
    ok,
    log: (line) => errout.write(`[hdc] ${target} ${verb}: ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target, verb, message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
