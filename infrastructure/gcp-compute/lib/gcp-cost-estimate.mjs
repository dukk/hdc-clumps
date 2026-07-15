import {
  DEFAULT_COST_DISCLAIMER,
  sumLineItems,
} from "hdc/package/cloud-cost-format.mjs";
import {
  fallbackCloudRunMonthlyUsd,
  fallbackDiskMonthlyUsd,
  fallbackVmMonthlyUsd,
} from "./gcp-fallback-prices.mjs";

/**
 * @typedef {import("../../../lib/cloud-cost-format.mjs").CostEstimate} CostEstimate
 */

/**
 * @param {import("./gcp-compute-config.mjs").NormalizedGcpDeployment} deployment
 * @param {{ catalogFn?: () => Promise<CostEstimate | null> }} [opts]
 * @returns {Promise<CostEstimate>}
 */
export async function estimateGcpDeploymentCost(deployment, opts = {}) {
  if (opts.catalogFn) {
    try {
      const catalog = await opts.catalogFn();
      if (catalog && !catalog.unknown) return catalog;
    } catch {
      /* fall through to fallback */
    }
  }

  const { mode, gcp } = deployment;
  /** @type {import("../../../lib/cloud-cost-format.mjs").CostLineItem[]} */
  const lineItems = [];

  if (mode === "gcp-vm") {
    const vmMonthly = fallbackVmMonthlyUsd(gcp.machine_type);
    if (vmMonthly !== null) {
      lineItems.push({
        label: `GCE ${gcp.machine_type}`,
        quantity: 1,
        unit: "month",
        monthly_usd: vmMonthly,
        notes: "fallback on-demand estimate",
      });
    }
    const diskMonthly = fallbackDiskMonthlyUsd(gcp.boot_disk_gb);
    lineItems.push({
      label: `Boot disk ${gcp.boot_disk_gb} GiB`,
      quantity: gcp.boot_disk_gb,
      unit: "GiB-month",
      monthly_usd: diskMonthly,
      notes: "fallback estimate",
    });
  } else {
    const monthly = fallbackCloudRunMonthlyUsd(
      gcp.cpu,
      gcp.memory_mb,
      gcp.min_instances,
      gcp.max_instances,
    );
    lineItems.push({
      label: `Cloud Run ${gcp.cpu} CPU / ${gcp.memory_mb} MiB`,
      quantity: 1,
      unit: "month",
      monthly_usd: monthly,
      notes: `min=${gcp.min_instances} max=${gcp.max_instances}`,
    });
  }

  if (!lineItems.length) {
    return {
      monthly_usd: null,
      hourly_usd: null,
      currency: "USD",
      line_items: [],
      source: "GCP fallback price table",
      disclaimer: DEFAULT_COST_DISCLAIMER,
      unknown: true,
    };
  }

  const sums = sumLineItems(lineItems);
  return {
    monthly_usd: sums.monthly_usd,
    hourly_usd: sums.monthly_usd / (24 * 30),
    currency: "USD",
    line_items: lineItems,
    source: "GCP fallback price table (Billing Catalog unavailable)",
    disclaimer: DEFAULT_COST_DISCLAIMER,
    unknown: false,
  };
}
