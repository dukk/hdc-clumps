import { stderr as errout } from "node:process";

import { extractPveUpid } from "./proxmox-qemu-post-clone.mjs";
import { getLxcRuntimeStatus, startLxc } from "./proxmox-lxc-start.mjs";
import { pveData, pveFormBody, pveJsonRequest, waitForPveTask } from "./pve-http.mjs";
import { parseIpv4FromNet0 } from "hdc/package/lxc-network.mjs";

/**
 * GET /nodes/{node}/lxc/{vmid}/config
 * @param {object} opts
 */
async function getLxcConfig(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const path = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/config`;
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const data = pveData(body);
  return data && typeof data === "object" && !Array.isArray(data)
    ? /** @type {Record<string, unknown>} */ (data)
    : {};
}

/**
 * POST /lxc/{vmid}/status/stop and wait for task.
 * @param {object} opts
 */
async function stopLxc(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/status/stop`;
  log(`Stopping LXC ${vmid} on ${node} …`);
  const body = await pveJsonRequest(
    "POST",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody({}),
  );
  const upid = extractPveUpid(pveData(body));
  if (upid) {
    await waitForPveTask({
      apiBase,
      node,
      upid,
      authorization,
      rejectUnauthorized,
      timeoutMs: 300_000,
      log,
    });
  }
  log(`LXC ${vmid} stop finished on ${node}.`);
}

/**
 * Stop if running, PUT net0, start. Applies static/DHCP network from config.
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.net0 full net0 line for Proxmox
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 */
export async function applyLxcNet0(opts) {
  const { apiBase, authorization, rejectUnauthorized, node, vmid, net0, dryRun } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));

  const beforeCfg = await getLxcConfig({
    apiBase,
    authorization,
    rejectUnauthorized,
    node,
    vmid,
  });
  const previousNet0 = typeof beforeCfg.net0 === "string" ? beforeCfg.net0 : "";

  if (dryRun) {
    log(`[dry-run] would set LXC ${vmid} on ${node} net0=${net0}`);
    return {
      ok: true,
      dry_run: true,
      previous_net0: previousNet0,
      net0,
      ip: parseIpv4FromNet0(net0),
    };
  }

  const statusOpts = { apiBase, authorization, rejectUnauthorized, node, vmid };
  const status = await getLxcRuntimeStatus(statusOpts);
  if (status === "running") {
    await stopLxc({ ...statusOpts, log });
  }

  const configPath = `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/config`;
  log(`Updating LXC ${vmid} net0 on ${node} …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    configPath,
    authorization,
    rejectUnauthorized,
    pveFormBody({ net0 }),
  );

  try {
    await startLxc({ ...statusOpts, log });
  } catch (e) {
    const afterStart = await getLxcRuntimeStatus(statusOpts);
    if (afterStart !== "running") {
      throw e;
    }
    log(
      `LXC ${vmid} start task reported ${/** @type {Error} */ (e).message} but container is running — continuing.`,
    );
  }

  const running = await getLxcRuntimeStatus(statusOpts);
  if (running !== "running") {
    throw new Error(`LXC ${vmid} on ${node} did not reach running state (status: ${running || "unknown"})`);
  }

  const afterCfg = await getLxcConfig({ apiBase, authorization, rejectUnauthorized, node, vmid });
  const appliedNet0 = typeof afterCfg.net0 === "string" ? afterCfg.net0 : net0;

  return {
    ok: true,
    previous_net0: previousNet0,
    net0: appliedNet0,
    ip: parseIpv4FromNet0(appliedNet0) ?? parseIpv4FromNet0(net0),
  };
}
