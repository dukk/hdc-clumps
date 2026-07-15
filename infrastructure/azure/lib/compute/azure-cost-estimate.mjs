import {
  DEFAULT_COST_DISCLAIMER,
  sumLineItems,
} from "hdc/package/cloud-cost-format.mjs";
import {
  hourlyVmPrice,
  monthlyAciPrice,
  monthlyManagedDiskPrice,
} from "./azure-retail-prices.mjs";

/**
 * @typedef {import("../../../../lib/cloud-cost-format.mjs").CostEstimate} CostEstimate
 */

/**
 * @param {import("./azure-compute-config.mjs").ReturnType<typeof import("./azure-compute-config.mjs").normalizeAzureComputeConfig>["deployments"][number]} deployment
 * @param {{ fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<CostEstimate>}
 */
export async function estimateAzureDeploymentCost(deployment, opts = {}) {
  const { mode, azure } = deployment;
  /** @type {import("../../../lib/cloud-cost-format.mjs").CostLineItem[]} */
  const lineItems = [];

  try {
    if (mode === "azure-vm") {
      const vmSize = azure.vm_size || "Standard_B2s";
      const hourly = await hourlyVmPrice(azure.location, vmSize, opts);
      if (hourly !== null) {
        const monthly = hourly * 24 * 30;
        lineItems.push({
          label: `VM ${vmSize}`,
          quantity: 1,
          unit: "hour",
          hourly_usd: hourly,
          monthly_usd: monthly,
        });
      }
      const diskMonthly = await monthlyManagedDiskPrice(azure.location, azure.os_disk_gb, opts);
      if (diskMonthly !== null) {
        lineItems.push({
          label: `OS disk ${azure.os_disk_gb} GiB`,
          quantity: azure.os_disk_gb,
          unit: "GiB-month",
          monthly_usd: diskMonthly,
        });
      }
      if (azure.public_ip) {
        lineItems.push({
          label: "Public IP (approx)",
          quantity: 1,
          unit: "month",
          monthly_usd: 3.65,
          notes: "Static IP estimate",
        });
      }
    } else if (mode === "azure-aci") {
      const monthly = await monthlyAciPrice(azure.location, azure.cpu, azure.memory_gb, opts);
      if (monthly !== null) {
        lineItems.push({
          label: `ACI ${azure.cpu} vCPU / ${azure.memory_gb} GiB`,
          quantity: 1,
          unit: "month",
          monthly_usd: monthly,
        });
      }
    }
  } catch {
    return {
      monthly_usd: null,
      hourly_usd: null,
      currency: "USD",
      line_items: [],
      source: "Azure Retail Prices API",
      disclaimer: DEFAULT_COST_DISCLAIMER,
      unknown: true,
    };
  }

  if (!lineItems.length) {
    return {
      monthly_usd: null,
      hourly_usd: null,
      currency: "USD",
      line_items: [],
      source: "Azure Retail Prices API",
      disclaimer: DEFAULT_COST_DISCLAIMER,
      unknown: true,
    };
  }

  const sums = sumLineItems(lineItems);
  return {
    monthly_usd: sums.monthly_usd,
    hourly_usd: sums.hourly_usd || null,
    currency: "USD",
    line_items: lineItems,
    source: "Azure Retail Prices API",
    disclaimer: DEFAULT_COST_DISCLAIMER,
    unknown: false,
  };
}
