import { describe, expect, it } from "vitest";

import { estimateGcpDeploymentCost } from "./gcp-cost-estimate.mjs";
import { normalizeGcpComputeConfig } from "./gcp-compute-config.mjs";

describe("gcp-cost-estimate", () => {
  it("estimates VM with fallback table", async () => {
    const cfg = normalizeGcpComputeConfig({
      defaults: {
        gcp: { project_id: "p", region: "us-central1", zone: "us-central1-a" },
      },
      deployments: [
        {
          id: "a",
          system_id: "virt-a",
          mode: "gcp-vm",
          gcp: { machine_type: "e2-small", boot_disk_gb: 30 },
        },
      ],
    });
    const est = await estimateGcpDeploymentCost(cfg.deployments[0]);
    expect(est.monthly_usd).toBeGreaterThan(0);
    expect(est.unknown).toBe(false);
  });

  it("estimates Cloud Run", async () => {
    const cfg = normalizeGcpComputeConfig({
      defaults: { gcp: { project_id: "p", region: "us-central1" } },
      deployments: [
        {
          id: "b",
          system_id: "virt-b",
          mode: "gcp-cloud-run",
          gcp: { image: "gcr.io/cloudrun/hello", cpu: 1, memory_mb: 512 },
        },
      ],
    });
    const est = await estimateGcpDeploymentCost(cfg.deployments[0]);
    expect(est.monthly_usd).toBeGreaterThan(0);
  });
});
