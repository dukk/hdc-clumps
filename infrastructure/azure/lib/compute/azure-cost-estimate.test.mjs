import { describe, expect, it, beforeEach } from "vitest";

import { estimateAzureDeploymentCost } from "./azure-cost-estimate.mjs";
import { resetRetailPriceCache } from "./azure-retail-prices.mjs";
import { normalizeAzureComputeConfig } from "./azure-compute-config.mjs";

describe("azure-cost-estimate", () => {
  beforeEach(() => resetRetailPriceCache());

  it("estimates VM from mocked retail API", async () => {
    const cfg = normalizeAzureComputeConfig({
      defaults: { azure: { subscription_id: "s", resource_group: "rg", location: "eastus" } },
      deployments: [
        {
          id: "a",
          system_id: "virt-a",
          mode: "azure-vm",
          azure: { vm_size: "Standard_B2s", os_disk_gb: 64, public_ip: false },
        },
      ],
    });
    const dep = cfg.deployments[0];

    /** @type {typeof fetch} */
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("Virtual Machines")) {
        return new Response(
          JSON.stringify({
            Items: [{ retailPrice: 0.05, unitOfMeasure: "1 Hour", type: "Consumption" }],
          }),
          { status: 200 },
        );
      }
      if (u.includes("Storage")) {
        return new Response(
          JSON.stringify({
            Items: [{ retailPrice: 4.8, unitOfMeasure: "1 Month", type: "Consumption" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ Items: [] }), { status: 200 });
    };

    const est = await estimateAzureDeploymentCost(dep, { fetchFn });
    expect(est.monthly_usd).toBeGreaterThan(0);
    expect(est.unknown).toBe(false);
    expect(est.line_items.length).toBeGreaterThan(0);
  });
});
