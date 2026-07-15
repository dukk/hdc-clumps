import { vmNotSupportedResult } from "hdc/package/host-provisioner.mjs";
import { createAzureArmClient, loadOperatorSshPublicKeys } from "./azure-arm-api.mjs";

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken
 * @param {string} opts.subscriptionId
 * @param {import("./azure-compute-config.mjs").ReturnType<typeof import("./azure-compute-config.mjs").normalizeAzureComputeConfig>["deployments"][number]} opts.deployment
 */
export function createAzureComputeHostProvisioner(opts) {
  const client = createAzureArmClient({
    getToken: opts.getToken,
    subscriptionId: opts.subscriptionId,
  });
  const deployment = opts.deployment;

  return {
    backendId: "azure-compute",

    /**
     * @param {import("../../../../lib/host-provisioner.mjs").ProvisionLog} log
     * @param {import("../../../../lib/host-provisioner.mjs").ContainerCreateSpec} spec
     */
    async createContainer(log, spec) {
      if (deployment.mode !== "azure-aci") {
        return {
          ok: false,
          message: `deployment mode ${deployment.mode} does not support createContainer`,
        };
      }
      log.info(`creating ACI ${deployment.azure.resource_name} in ${deployment.azure.location}`);
      try {
        const result = await client.deployAci(deployment);
        return {
          ok: true,
          message: `ACI ${result.resource_name} provisioned`,
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
     * @param {import("../../../lib/host-provisioner.mjs").VmCreateSpec} spec
     */
    async createVm(log, spec) {
      if (deployment.mode !== "azure-vm") {
        return vmNotSupportedResult("azure-compute");
      }
      log.info(`creating Azure VM ${deployment.azure.resource_name} in ${deployment.azure.location}`);
      try {
        const keys = loadOperatorSshPublicKeys();
        if (!keys.length) {
          log.warn("no ~/.ssh public keys found; VM will rely on admin user config only");
        }
        const result = await client.deployVm(deployment, keys);
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
