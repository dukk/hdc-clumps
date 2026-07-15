import { describe, expect, it } from "vitest";

import { normalizeAzureComputeConfig, resolveAzureComputeDeployments } from "./azure-compute-config.mjs";
import { extractComputeConfigRaw } from "./azure-compute-run-context.mjs";

describe("azure-compute-config", () => {
  it("extracts compute section from unified azure config", () => {
    const raw = extractComputeConfigRaw({
      schema_version: 2,
      entra: { applications: [] },
      compute: {
        defaults: {
          azure: {
            subscription_id: "sub-1",
            resource_group: "rg",
            location: "eastus",
          },
        },
        deployments: [
          {
            id: "a",
            system_id: "virt-azure-compute-a",
            mode: "azure-vm",
            azure: { vm_size: "Standard_B2s" },
          },
        ],
      },
    });
    const cfg = normalizeAzureComputeConfig(raw);
    expect(cfg.deployments).toHaveLength(1);
    expect(cfg.deployments[0].azure.subscription_id).toBe("sub-1");
  });

  it("merges defaults into deployments", () => {
    const cfg = normalizeAzureComputeConfig({
      schema_version: 1,
      defaults: {
        azure: {
          subscription_id: "sub-1",
          resource_group: "hdc-rg",
          location: "eastus",
        },
      },
      deployments: [
        {
          id: "a",
          system_id: "virt-azure-compute-a",
          mode: "azure-vm",
          azure: { vm_size: "Standard_B2s" },
        },
      ],
    });
    expect(cfg.deployments).toHaveLength(1);
    expect(cfg.deployments[0].azure.location).toBe("eastus");
    expect(cfg.deployments[0].azure.vm_size).toBe("Standard_B2s");
  });

  it("rejects invalid mode", () => {
    expect(() =>
      normalizeAzureComputeConfig({
        deployments: [{ id: "a", system_id: "x", mode: "aws-ec2", azure: {} }],
      }),
    ).toThrow(/azure-vm or azure-aci/);
  });

  it("filters by instance", () => {
    const cfg = normalizeAzureComputeConfig({
      defaults: { azure: { subscription_id: "s", resource_group: "rg", location: "eastus" } },
      deployments: [
        { id: "a", system_id: "virt-a", mode: "azure-vm", azure: {} },
        { id: "b", system_id: "virt-b", mode: "azure-aci", azure: { cpu: 1, memory_gb: 1 } },
      ],
    });
    const one = resolveAzureComputeDeployments(cfg, { instance: "b" });
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe("b");
  });
});
