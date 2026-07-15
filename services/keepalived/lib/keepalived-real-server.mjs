import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  buildDrRealServerCommands,
  buildNatRealServerVerifyCommand,
  shellQuote,
} from "./keepalived-render.mjs";
import {
  directorVipAddresses,
  virtualServersForRealServer,
} from "./deployments.mjs";

export { createConfigureExec };

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 120)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").finalizeRealServerDeployment>} opts.deployment
 * @param {ReturnType<typeof import("./deployments.mjs").parseVirtualServers>} opts.virtualServers
 * @param {ReturnType<typeof import("./deployments.mjs").parseVrrpInstances>} opts.vrrpInstances
 */
export async function configureKeepalivedRealServer(opts) {
  const { exec, log, deployment, virtualServers, vrrpInstances } = opts;
  const vsList = virtualServersForRealServer(virtualServers, deployment.virtualServerIds);
  const lbKind = deployment.lbKind;

  /** @type {string[]} */
  const notes = [];

  if (lbKind === "DR") {
    const vips = [
      ...new Set([
        ...vsList.map((vs) => `${vs.vip}/32`),
        ...directorVipAddresses(vrrpInstances, vsList).map((v) =>
          v.includes("/") ? v : `${v}/32`,
        ),
      ]),
    ];
    for (const vip of vips) {
      runChecked(exec, buildDrRealServerCommands(vip), log);
    }
    notes.push(`DR: loopback VIP(s) ${vips.join(", ")}`);
  } else if (lbKind === "NAT") {
    const directorVips = directorVipAddresses(vrrpInstances, vsList);
    for (const vip of directorVips) {
      const r = exec.run(buildNatRealServerVerifyCommand(vip), { capture: true });
      const out = `${r.stdout}${r.stderr}`.trim();
      if (out.includes("nat_gw_check")) {
        notes.push(out);
        log.warn(out);
      } else {
        notes.push(`NAT: default route uses director VIP ${vip}`);
      }
    }
  } else {
    notes.push(`TUN: no automatic real-server prep (verify tunnel endpoints manually)`);
  }

  return {
    ok: true,
    lb_kind: lbKind,
    virtual_server_ids: deployment.virtualServerIds,
    notes,
  };
}
