import { describe, expect, it } from "vitest";

import { normalizeGcpComputeConfig, resolveGcpComputeDeployments } from "./gcp-compute-config.mjs";

describe("gcp-compute-config", () => {
  it("merges defaults into deployments", () => {
    const cfg = normalizeGcpComputeConfig({
      schema_version: 1,
      defaults: {
        gcp: {
          project_id: "my-project",
          region: "us-central1",
          zone: "us-central1-a",
        },
      },
      deployments: [
        {
          id: "a",
          system_id: "virt-gcp-compute-a",
          mode: "gcp-vm",
          gcp: { machine_type: "e2-small" },
        },
      ],
    });
    expect(cfg.deployments[0].gcp.project_id).toBe("my-project");
    expect(cfg.deployments[0].gcp.machine_type).toBe("e2-small");
  });

  it("requires zone for gcp-vm", () => {
    expect(() =>
      normalizeGcpComputeConfig({
        defaults: { gcp: { project_id: "p", region: "us-central1" } },
        deployments: [{ id: "a", system_id: "x", mode: "gcp-vm", gcp: {} }],
      }),
    ).toThrow(/zone required/);
  });
});
