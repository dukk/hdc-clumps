import { buildCostEstimate } from "hdc/package/aws-cost-estimate.mjs";
import {
  fallbackBootVolumeMonthlyUsd,
  fallbackContainerMonthlyUsd,
  fallbackFlexAdjustUsd,
  fallbackVmMonthlyUsd,
} from "./oci-fallback-prices.mjs";

/** @typedef {import("../../../lib/aws-cost-estimate.mjs").CostEstimate} CostEstimate */
/** @typedef {import("./oci-plan.mjs").OciPlanAction} OciPlanAction */

const OCI_COST_DISCLAIMER =
  "Estimates use OCI fallback list prices in USD. Always Free shapes may be $0; excludes data transfer, tax, and partial-month proration.";

/**
 * @param {OciPlanAction[]} actions
 */
export function estimatePlanCost(actions) {
  /** @type {import("../../../lib/aws-cost-estimate.mjs").CostEstimateLine[]} */
  const lines = [];
  /** @type {string[]} */
  const warnings = [];

  for (const action of actions) {
    if (action.action !== "create") continue;
    const desired = action.desired ?? {};

    if (action.kind === "instance") {
      const shape = String(desired.shape ?? "VM.Standard.E2.1.Micro");
      let monthly = fallbackVmMonthlyUsd(shape);
      if (monthly === null) {
        warnings.push(`Unknown VM shape ${shape}; estimate omitted`);
        continue;
      }
      if (shape.includes("Flex")) {
        monthly += fallbackFlexAdjustUsd(Number(desired.ocpus) || 1, Number(desired.memory_gb) || 1);
      }
      monthly += fallbackBootVolumeMonthlyUsd(Number(desired.boot_volume_gb) || 50);
      lines.push({
        resource_id: action.resource_id,
        service: `OCI VM ${shape}`,
        monthly_usd: monthly,
      });
    }

    if (action.kind === "container_instance") {
      const shape = String(desired.shape ?? "CI.Standard.E4.Flex");
      let monthly = fallbackContainerMonthlyUsd(shape);
      if (monthly === null) {
        warnings.push(`Unknown container shape ${shape}; estimate omitted`);
        continue;
      }
      monthly += fallbackFlexAdjustUsd(Number(desired.ocpus) || 1, Number(desired.memory_gb) || 2);
      lines.push({
        resource_id: action.resource_id,
        service: `OCI Container ${shape}`,
        monthly_usd: monthly,
      });
    }

    if (action.kind === "vcn" || action.kind === "subnet" || action.kind === "nsg") {
      lines.push({
        resource_id: action.resource_id,
        service: `OCI ${action.kind}`,
        monthly_usd: 0,
        notes: "no charge",
      });
    }
  }

  const estimate = buildCostEstimate(lines, { disclaimer: OCI_COST_DISCLAIMER, warnings });
  return {
    ...estimate,
    unknown: estimate.lines.length === 0 && actions.some((a) => a.action === "create"),
  };
}

/**
 * @param {import("./oci-config.mjs").NormalizedOciInstance} instance
 */
export function estimateInstanceCost(instance) {
  const shape = instance.shape;
  let monthly = fallbackVmMonthlyUsd(shape) ?? 0;
  if (shape.includes("Flex")) {
    monthly += fallbackFlexAdjustUsd(instance.ocpus, instance.memory_gb);
  }
  monthly += fallbackBootVolumeMonthlyUsd(instance.boot_volume_gb);
  return {
    ...buildCostEstimate(
      [{ resource_id: instance.id, service: `OCI VM ${shape}`, monthly_usd: monthly }],
      { disclaimer: OCI_COST_DISCLAIMER },
    ),
    unknown: fallbackVmMonthlyUsd(shape) === null,
  };
}

/**
 * @param {import("./oci-config.mjs").NormalizedContainerInstance} ci
 */
export function estimateContainerInstanceCost(ci) {
  const shape = ci.shape;
  let monthly = fallbackContainerMonthlyUsd(shape) ?? 0;
  monthly += fallbackFlexAdjustUsd(ci.ocpus, ci.memory_gb);
  return {
    ...buildCostEstimate(
      [{ resource_id: ci.id, service: `OCI Container ${shape}`, monthly_usd: monthly }],
      { disclaimer: OCI_COST_DISCLAIMER },
    ),
    unknown: fallbackContainerMonthlyUsd(shape) === null,
  };
}
