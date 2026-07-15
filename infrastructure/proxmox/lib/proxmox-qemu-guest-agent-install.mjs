import { pveFormBody, pveJsonRequest } from "./pve-http.mjs";
import {
  fetchQemuConfigAgentState,
  pingQemuGuestAgent,
  qemuAgentEnabledFromConfig,
} from "./proxmox-qemu-guest-agent.mjs";
import { createGuestSshExec } from "hdc/package/guest-ssh-exec.mjs";

const PING_POLL_MS = 5_000;
const PING_TIMEOUT_MS = 120_000;

/**
 * @returns {string}
 */
export function qemuGuestAgentAptInstallScript() {
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq qemu-guest-agent",
    "systemctl enable --now qemu-guest-agent",
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {(line: string) => void} [opts.log]
 */
export async function enableQemuAgentInConfig(opts) {
  const { apiBase, node, vmid, authorization, rejectUnauthorized, log } = opts;
  const { enabled } = await fetchQemuConfigAgentState(
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
  );
  if (enabled) {
    log?.(`QEMU ${vmid}: agent already enabled in VM config.`);
    return { enabled: true, changed: false };
  }
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  log?.(`QEMU ${vmid}: enabling agent in VM config …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({ agent: "1" }),
  );
  log?.(`QEMU ${vmid}: agent enabled in VM config.`);
  return { enabled: true, changed: true };
}

/**
 * @param {string} user
 * @param {string} host
 * @param {(line: string) => void} [log]
 */
export async function installQemuGuestAgentViaSsh(user, host, log) {
  const exec = createGuestSshExec({
    host,
    configuredUser: user,
    log,
  });
  log?.(`Installing qemu-guest-agent on ${exec.label} …`);
  const r = exec.run(qemuGuestAgentAptInstallScript(), { capture: true });
  if (r.status !== 0) {
    throw new Error(
      `qemu-guest-agent install failed on ${exec.label} (exit ${r.status})${r.stderr ? `: ${r.stderr.trim()}` : ""}`,
    );
  }
  log?.(`qemu-guest-agent installed on ${exec.label}.`);
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {(line: string) => void} [opts.log]
 * @param {number} [opts.timeoutMs]
 */
export async function waitForQemuGuestAgentPing(opts) {
  const {
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
    log,
    timeoutMs = PING_TIMEOUT_MS,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const probe = await pingQemuGuestAgent(apiBase, node, vmid, authorization, rejectUnauthorized);
    if (probe.ok) {
      log?.(`QEMU ${vmid}: guest agent responding (attempt ${attempt}).`);
      return;
    }
    log?.(`QEMU ${vmid}: guest agent not responding yet (attempt ${attempt}) …`);
    await new Promise((resolve) => setTimeout(resolve, PING_POLL_MS));
  }
  throw new Error(`QEMU ${vmid}: guest agent did not respond within ${timeoutMs}ms`);
}

/**
 * Enable agent in VM config and optionally install in guest via SSH.
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} [opts.sshUser]
 * @param {string} [opts.sshHost]
 * @param {boolean} [opts.verifyPing] Default true when SSH install runs.
 * @param {(line: string) => void} [opts.log]
 */
export async function ensureQemuGuestAgentOnDeploy(opts) {
  const {
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
    sshUser,
    sshHost,
    verifyPing = true,
    log,
  } = opts;

  await enableQemuAgentInConfig({
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
    log,
  });

  const user = typeof sshUser === "string" ? sshUser.trim() : "";
  const host = typeof sshHost === "string" ? sshHost.trim() : "";
  if (!user || !host) {
    log?.(`QEMU ${vmid}: no guest SSH target — in-guest qemu-guest-agent install skipped.`);
    return;
  }

  await installQemuGuestAgentViaSsh(user, host, log);

  if (verifyPing) {
    await waitForQemuGuestAgentPing({
      apiBase,
      node,
      vmid,
      authorization,
      rejectUnauthorized,
      log,
    });
  }
}

/**
 * @param {Record<string, unknown> | null} config
 * @returns {boolean}
 */
export function agentEnabledInConfigRecord(config) {
  return config ? qemuAgentEnabledFromConfig(config.agent) : false;
}
