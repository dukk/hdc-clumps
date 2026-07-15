import { vmNotSupportedResult } from "hdc/package/host-provisioner.mjs";
import { normalizeOciComputeConfig } from "./oci-config.mjs";
import { collectOciLiveState } from "./oci-collect.mjs";
import { planOciSync } from "./oci-plan.mjs";
import { applyOciPlan } from "./oci-sync.mjs";

/** @typedef {import("./oci-api.mjs").OciClient} OciClient */
/** @typedef {import("./oci-config.mjs").NormalizedOciComputeConfig} NormalizedOciComputeConfig */

/**
 * @param {NormalizedOciComputeConfig} base
 * @param {import("./oci-config.mjs").NormalizedOciInstance} instance
 */
function overlayVmConfig(base, instance) {
  const subnet = base.subnetsById.get(instance.subnet_id);
  const vcn = subnet ? base.vcnsById.get(subnet.vcn_id) : null;
  const nsgs = instance.nsg_ids.map((id) => base.nsgsById.get(id)).filter(Boolean);
  return normalizeOciComputeConfig({
    schema_version: base.schema_version,
    oci: {
      region: base.region,
      compartment_id: base.compartment_id,
      availability_domain: base.availability_domain,
      default_tags: base.default_tags,
    },
    cost: { confirm_before_deploy: false },
    vcns: vcn ? [vcn] : [],
    subnets: subnet ? [subnet] : [],
    network_security_groups: nsgs,
    instances: [instance],
    container_instances: [],
  });
}

/**
 * @param {NormalizedOciComputeConfig} base
 * @param {import("./oci-config.mjs").NormalizedContainerInstance} ci
 */
function overlayContainerConfig(base, ci) {
  const subnet = base.subnetsById.get(ci.subnet_id);
  const vcn = subnet ? base.vcnsById.get(subnet.vcn_id) : null;
  const nsgs = ci.nsg_ids.map((id) => base.nsgsById.get(id)).filter(Boolean);
  return normalizeOciComputeConfig({
    schema_version: base.schema_version,
    oci: {
      region: base.region,
      compartment_id: base.compartment_id,
      availability_domain: base.availability_domain,
      default_tags: base.default_tags,
    },
    cost: { confirm_before_deploy: false },
    vcns: vcn ? [vcn] : [],
    subnets: subnet ? [subnet] : [],
    network_security_groups: nsgs,
    instances: [],
    container_instances: [ci],
  });
}

/**
 * @param {object} opts
 * @param {"oci-vm" | "oci-container"} opts.mode
 * @param {NormalizedOciComputeConfig} opts.baseConfig
 * @param {OciClient} opts.client
 * @param {import("./oci-config.mjs").NormalizedOciInstance | import("./oci-config.mjs").NormalizedContainerInstance} opts.deployment
 */
export function createOciComputeHostProvisioner(opts) {
  const { mode, baseConfig, client, deployment } = opts;

  /**
   * @param {import("./oci-config.mjs").NormalizedOciComputeConfig} cfg
   */
  async function applyConfig(cfg) {
    const live = await collectOciLiveState(client, cfg);
    const actions = planOciSync({ config: cfg, live }).filter((a) => a.action === "create");
    if (!actions.length) {
      return { ok: true, message: "resource already exists", results: [] };
    }
    const results = await applyOciPlan({
      client,
      config: cfg,
      live,
      actions,
      dryRun: false,
      log: () => {},
    });
    return { ok: true, message: "provisioned", results };
  }

  return {
    backendId: "oci-compute",

    async createContainer(log, _spec) {
      if (mode !== "oci-container") {
        return {
          ok: false,
          message: `deployment mode ${mode} does not support createContainer`,
        };
      }
      const ci = /** @type {import("./oci-config.mjs").NormalizedContainerInstance} */ (deployment);
      log.info(`creating OCI container instance ${ci.system_id}`);
      try {
        const cfg = overlayContainerConfig(baseConfig, ci);
        const result = await applyConfig(cfg);
        return {
          ok: result.ok,
          message: result.message,
          details: { system_id: ci.system_id, mode: "oci-container", results: result.results },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },

    async createVm(log, _spec) {
      if (mode !== "oci-vm") {
        return vmNotSupportedResult("oci-compute");
      }
      const inst = /** @type {import("./oci-config.mjs").NormalizedOciInstance} */ (deployment);
      log.info(`creating OCI VM ${inst.system_id}`);
      try {
        const cfg = overlayVmConfig(baseConfig, inst);
        const result = await applyConfig(cfg);
        return {
          ok: result.ok,
          message: result.message,
          details: { system_id: inst.system_id, mode: "oci-vm", results: result.results },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },
  };
}
