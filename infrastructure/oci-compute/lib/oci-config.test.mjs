import { describe, expect, it } from "vitest";

import { normalizeOciComputeConfig, resolveOciResourceFilter } from "./oci-config.mjs";
import { expandedResourceFilter, planOciSync } from "./oci-plan.mjs";

describe("oci-compute-config", () => {
  const sample = {
    schema_version: 1,
    oci: {
      region: "us-ashburn-1",
      compartment_id: "ocid1.compartment.oc1..test",
    },
    vcns: [{ id: "vcn-main", managed: true, cidr: "10.50.0.0/16", dns_label: "hdcvcn" }],
    subnets: [
      {
        id: "subnet-public-a",
        managed: true,
        vcn_id: "vcn-main",
        cidr: "10.50.1.0/24",
        public: true,
      },
    ],
    network_security_groups: [
      {
        id: "nsg-default",
        managed: true,
        vcn_id: "vcn-main",
        ingress: [{ protocol: "tcp", port_min: 22, port_max: 22, source: "0.0.0.0/0" }],
      },
    ],
    instances: [
      {
        id: "a",
        managed: true,
        system_id: "virt-oci-a",
        subnet_id: "subnet-public-a",
        nsg_ids: ["nsg-default"],
        image_ocid: "ocid1.image.oc1.iad.example",
      },
    ],
    container_instances: [
      {
        id: "b",
        managed: true,
        system_id: "virt-oci-container-a",
        subnet_id: "subnet-public-a",
        containers: [{ name: "app", image: "ghcr.io/example/app:latest" }],
      },
    ],
  };

  it("normalizes networking and compute entries", () => {
    const cfg = normalizeOciComputeConfig(sample);
    expect(cfg.region).toBe("us-ashburn-1");
    expect(cfg.instances[0].shape).toBe("VM.Standard.E2.1.Micro");
    expect(cfg.container_instances[0].shape).toBe("CI.Standard.E4.Flex");
  });

  it("requires image_ocid for instances", () => {
    expect(() =>
      normalizeOciComputeConfig({
        ...sample,
        instances: [{ id: "a", managed: true, system_id: "x", subnet_id: "subnet-public-a" }],
      }),
    ).toThrow(/image_ocid/);
  });

  it("resolves resource filter ids", () => {
    const cfg = normalizeOciComputeConfig(sample);
    expect(resolveOciResourceFilter(cfg, { resource: "a" })).toBe("a");
    expect(() => resolveOciResourceFilter(cfg, { resource: "missing" })).toThrow(/No resource/);
  });

  it("expands NSG resource filter to public subnets in the same VCN", () => {
    const cfg = normalizeOciComputeConfig(sample);
    const ids = expandedResourceFilter(cfg, "nsg-default");
    expect(ids?.has("nsg-default")).toBe(true);
    expect(ids?.has("vcn-main")).toBe(true);
    expect(ids?.has("subnet-public-a")).toBe(true);
  });

  it("plans create actions for missing live resources", () => {
    const cfg = normalizeOciComputeConfig(sample);
    const live = {
      vcns: [],
      subnets: [],
      network_security_groups: [],
      internet_gateways: [],
      route_tables: [],
      instances: [],
      container_instances: [],
      byResourceId() {
        return new Map();
      },
    };
    const actions = planOciSync({ config: cfg, live, resourceFilter: "a" });
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain("vcn");
    expect(kinds).toContain("subnet");
    expect(kinds).toContain("instance");
    expect(actions.find((a) => a.resource_id === "a")?.action).toBe("create");
  });
});
