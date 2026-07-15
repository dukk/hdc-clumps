import { vmNotSupportedResult } from "hdc/package/host-provisioner.mjs";
import { createGcpComputeClient } from "./gcp-compute-api.mjs";

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken
 * @param {string} opts.projectId
 * @param {import("./gcp-compute-config.mjs").NormalizedGcpDeployment} opts.deployment
 */
export function createGcpComputeHostProvisioner(opts) {
  const client = createGcpComputeClient({
    getToken: opts.getToken,
    projectId: opts.projectId,
  });
  const deployment = opts.deployment;

  return {
    backendId: "gcp-compute",

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     */
    async createContainer(log, _spec) {
      if (deployment.mode !== "gcp-cloud-run") {
        return {
          ok: false,
          message: `deployment mode ${deployment.mode} does not support createContainer`,
        };
      }
      log.info(`creating Cloud Run service ${deployment.gcp.resource_name} in ${deployment.gcp.region}`);
      try {
        const result = await client.deployCloudRun(deployment);
        return {
          ok: true,
          message: `Cloud Run ${result.resource_name} provisioned`,
          details: result,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     */
    async createVm(log, _spec) {
      if (deployment.mode !== "gcp-vm") {
        return vmNotSupportedResult("gcp-compute");
      }
      log.info(`creating GCE VM ${deployment.gcp.resource_name} in ${deployment.gcp.zone}`);
      try {
        const result = await client.deployVm(deployment);
        return {
          ok: true,
          message: `VM ${result.resource_name} provisioned`,
          details: result,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },
  };
}
