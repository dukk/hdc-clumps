import { describe, expect, it } from "vitest";

import { normalizeAwsConfig } from "./aws-config.mjs";

describe("normalizeAwsConfig", () => {
  it("normalizes a minimal valid config", () => {
    const cfg = normalizeAwsConfig({
      schema_version: 1,
      aws: { region: "us-east-1" },
      vpcs: [{ id: "vpc-main", cidr: "192.0.2.0/16" }],
      subnets: [
        { id: "subnet-a", vpc_id: "vpc-main", cidr: "10.0.1.0/24", az: "us-east-1a" },
      ],
      ec2_instances: [
        {
          id: "vm-a",
          instance_type: "t3.micro",
          ami: "ami-123",
          subnet_id: "subnet-a",
        },
      ],
    });
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.vpcs).toHaveLength(1);
    expect(cfg.ec2ById.get("vm-a")?.instance_type).toBe("t3.micro");
    expect(cfg.confirm_before_deploy).toBe(true);
  });

  it("throws when region missing", () => {
    expect(() => normalizeAwsConfig({ schema_version: 1 })).toThrow(/region/i);
  });
});
