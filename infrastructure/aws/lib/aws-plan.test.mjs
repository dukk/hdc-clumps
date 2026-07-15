import { describe, expect, it } from "vitest";

import { normalizeAwsConfig } from "./aws-config.mjs";
import { planAwsSync, planHasCreates, sortPlanActions } from "./aws-plan.mjs";

describe("planAwsSync", () => {
  const config = normalizeAwsConfig({
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

  it("plans creates for missing live resources", () => {
    const actions = planAwsSync({
      config,
      liveByKind: {
        vpcs: new Map(),
        subnets: new Map(),
        security_groups: new Map(),
        iam_roles: new Map(),
        ebs_volumes: new Map(),
        ec2_instances: new Map(),
        s3_buckets: new Map(),
        ecs_clusters: new Map(),
        ecs_services: new Map(),
      },
    });
    expect(planHasCreates(actions)).toBe(true);
    expect(actions.some((a) => a.kind === "vpc" && a.action === "create")).toBe(true);
    expect(actions.some((a) => a.kind === "ec2_instance" && a.action === "create")).toBe(true);
  });

  it("orders vpc before ec2", () => {
    const actions = planAwsSync({
      config,
      liveByKind: {
        vpcs: new Map(),
        subnets: new Map(),
        security_groups: new Map(),
        iam_roles: new Map(),
        ebs_volumes: new Map(),
        ec2_instances: new Map(),
        s3_buckets: new Map(),
        ecs_clusters: new Map(),
        ecs_services: new Map(),
      },
    });
    const sorted = sortPlanActions(actions);
    const vpcIdx = sorted.findIndex((a) => a.kind === "vpc");
    const ec2Idx = sorted.findIndex((a) => a.kind === "ec2_instance");
    expect(vpcIdx).toBeLessThan(ec2Idx);
  });
});
