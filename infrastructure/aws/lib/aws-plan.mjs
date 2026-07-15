/** @typedef {import("./aws-config.mjs").NormalizedAwsConfig} NormalizedAwsConfig */

/**
 * @typedef {"iam_role" | "vpc" | "subnet" | "security_group" | "ebs_volume" | "ec2_instance" | "s3_bucket" | "ecs_cluster" | "ecs_service"} AwsResourceKind
 */

/**
 * @typedef {object} AwsPlanAction
 * @property {AwsResourceKind} kind
 * @property {string} resource_id
 * @property {"create" | "update" | "delete" | "noop"} action
 * @property {Record<string, unknown> | null} [desired]
 * @property {Record<string, unknown> | null} [live]
 * @property {string[]} [notes]
 */

/** Apply order for creates/updates. */
export const AWS_RESOURCE_ORDER = [
  "iam_role",
  "vpc",
  "subnet",
  "security_group",
  "ebs_volume",
  "ec2_instance",
  "s3_bucket",
  "ecs_cluster",
  "ecs_service",
];

/**
 * @param {AwsPlanAction[]} actions
 */
export function sortPlanActions(actions) {
  return [...actions].sort((a, b) => {
    const oa = AWS_RESOURCE_ORDER.indexOf(a.kind);
    const ob = AWS_RESOURCE_ORDER.indexOf(b.kind);
    if (oa !== ob) return oa - ob;
    if (a.action === "delete" && b.action !== "delete") return 1;
    if (b.action === "delete" && a.action !== "delete") return -1;
    return a.resource_id.localeCompare(b.resource_id);
  });
}

/**
 * @param {AwsPlanAction[]} actions
 */
export function planHasCreates(actions) {
  return actions.some((a) => a.action === "create");
}

/**
 * @param {Record<string, unknown> | null | undefined} live
 * @param {Record<string, unknown>} desired
 * @param {string[]} compareKeys
 */
function driftDetected(live, desired, compareKeys) {
  if (!live) return false;
  for (const key of compareKeys) {
    const a = JSON.stringify(live[key] ?? null);
    const b = JSON.stringify(desired[key] ?? null);
    if (a !== b) return true;
  }
  return false;
}

/**
 * @param {object} opts
 * @param {NormalizedAwsConfig} opts.config
 * @param {Record<string, unknown>} opts.liveByKind
 * @param {boolean} [opts.prune]
 * @param {string} [opts.resourceFilter]
 * @returns {AwsPlanAction[]}
 */
export function planAwsSync(opts) {
  const { config, liveByKind, prune = false, resourceFilter } = opts;
  const managed = resourceFilter
    ? {
        vpcs: config.vpcs.filter((v) => v.managed && v.id === resourceFilter),
        subnets: config.subnets.filter((s) => s.managed && s.id === resourceFilter),
        security_groups: config.security_groups.filter((s) => s.managed && s.id === resourceFilter),
        iam_roles: config.iam_roles.filter((r) => r.managed && r.id === resourceFilter),
        ebs_volumes: config.ebs_volumes.filter((v) => v.managed && v.id === resourceFilter),
        ec2_instances: config.ec2_instances.filter((i) => i.managed && i.id === resourceFilter),
        s3_buckets: config.s3_buckets.filter((b) => b.managed && b.id === resourceFilter),
        ecs_clusters: config.ecs_clusters.filter((c) => c.managed && c.id === resourceFilter),
        ecs_services: config.ecs_services.filter((s) => s.managed && s.id === resourceFilter),
      }
    : {
        vpcs: config.vpcs.filter((v) => v.managed),
        subnets: config.subnets.filter((s) => s.managed),
        security_groups: config.security_groups.filter((s) => s.managed),
        iam_roles: config.iam_roles.filter((r) => r.managed),
        ebs_volumes: config.ebs_volumes.filter((v) => v.managed),
        ec2_instances: config.ec2_instances.filter((i) => i.managed),
        s3_buckets: config.s3_buckets.filter((b) => b.managed),
        ecs_clusters: config.ecs_clusters.filter((c) => c.managed),
        ecs_services: config.ecs_services.filter((s) => s.managed),
      };

  /** @type {AwsPlanAction[]} */
  const actions = [];

  const liveIam = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.iam_roles ?? new Map());
  for (const role of managed.iam_roles) {
    const live = liveIam.get(role.id) ?? null;
    const desired = { name: role.name, trust: role.trust, managed_policy_arns: role.managed_policy_arns };
    if (!live) actions.push({ kind: "iam_role", resource_id: role.id, action: "create", desired: { ...role } });
    else if (driftDetected(live, desired, ["trust", "managed_policy_arns"]))
      actions.push({ kind: "iam_role", resource_id: role.id, action: "update", desired: { ...role }, live });
    else actions.push({ kind: "iam_role", resource_id: role.id, action: "noop", desired: { ...role }, live });
  }

  const liveVpc = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.vpcs ?? new Map());
  for (const vpc of managed.vpcs) {
    const live = liveVpc.get(vpc.id) ?? null;
    const desired = { cidr: vpc.cidr, enable_nat_gateway: vpc.enable_nat_gateway };
    if (!live) actions.push({ kind: "vpc", resource_id: vpc.id, action: "create", desired: { ...vpc } });
    else if (driftDetected(live, desired, ["cidr", "enable_nat_gateway"]))
      actions.push({ kind: "vpc", resource_id: vpc.id, action: "update", desired: { ...vpc }, live, notes: ["VPC CIDR changes are not supported in-place"] });
    else actions.push({ kind: "vpc", resource_id: vpc.id, action: "noop", desired: { ...vpc }, live });
  }

  const liveSubnet = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.subnets ?? new Map());
  for (const subnet of managed.subnets) {
    const live = liveSubnet.get(subnet.id) ?? null;
    if (!live) actions.push({ kind: "subnet", resource_id: subnet.id, action: "create", desired: { ...subnet } });
    else actions.push({ kind: "subnet", resource_id: subnet.id, action: "noop", desired: { ...subnet }, live });
  }

  const liveSg = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.security_groups ?? new Map());
  for (const sg of managed.security_groups) {
    const live = liveSg.get(sg.id) ?? null;
    if (!live) actions.push({ kind: "security_group", resource_id: sg.id, action: "create", desired: { ...sg } });
    else if (driftDetected(live, { ingress: sg.ingress, egress: sg.egress }, ["ingress", "egress"]))
      actions.push({ kind: "security_group", resource_id: sg.id, action: "update", desired: { ...sg }, live });
    else actions.push({ kind: "security_group", resource_id: sg.id, action: "noop", desired: { ...sg }, live });
  }

  const liveEbs = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.ebs_volumes ?? new Map());
  for (const vol of managed.ebs_volumes) {
    const live = liveEbs.get(vol.id) ?? null;
    if (!live) actions.push({ kind: "ebs_volume", resource_id: vol.id, action: "create", desired: { ...vol } });
    else actions.push({ kind: "ebs_volume", resource_id: vol.id, action: "noop", desired: { ...vol }, live });
  }

  const liveEc2 = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.ec2_instances ?? new Map());
  for (const inst of managed.ec2_instances) {
    const live = liveEc2.get(inst.id) ?? null;
    if (!live) actions.push({ kind: "ec2_instance", resource_id: inst.id, action: "create", desired: { ...inst } });
    else if (driftDetected(live, { instance_type: inst.instance_type, desired_count: 1 }, ["instance_type"]))
      actions.push({ kind: "ec2_instance", resource_id: inst.id, action: "update", desired: { ...inst }, live });
    else actions.push({ kind: "ec2_instance", resource_id: inst.id, action: "noop", desired: { ...inst }, live });
  }

  const liveS3 = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.s3_buckets ?? new Map());
  for (const bucket of managed.s3_buckets) {
    const live = liveS3.get(bucket.id) ?? null;
    if (!live) actions.push({ kind: "s3_bucket", resource_id: bucket.id, action: "create", desired: { ...bucket } });
    else if (driftDetected(live, { versioning: bucket.versioning, encryption: bucket.encryption }, ["versioning", "encryption"]))
      actions.push({ kind: "s3_bucket", resource_id: bucket.id, action: "update", desired: { ...bucket }, live });
    else actions.push({ kind: "s3_bucket", resource_id: bucket.id, action: "noop", desired: { ...bucket }, live });
  }

  const liveEcsCluster = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.ecs_clusters ?? new Map());
  for (const cluster of managed.ecs_clusters) {
    const live = liveEcsCluster.get(cluster.id) ?? null;
    if (!live) actions.push({ kind: "ecs_cluster", resource_id: cluster.id, action: "create", desired: { ...cluster } });
    else actions.push({ kind: "ecs_cluster", resource_id: cluster.id, action: "noop", desired: { ...cluster }, live });
  }

  const liveEcsService = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind.ecs_services ?? new Map());
  for (const svc of managed.ecs_services) {
    const live = liveEcsService.get(svc.id) ?? null;
    if (!live) actions.push({ kind: "ecs_service", resource_id: svc.id, action: "create", desired: { ...svc } });
    else if (
      driftDetected(
        live,
        { cpu: svc.cpu, memory: svc.memory, desired_count: svc.desired_count, containers: svc.containers },
        ["cpu", "memory", "desired_count", "containers"],
      )
    )
      actions.push({ kind: "ecs_service", resource_id: svc.id, action: "update", desired: { ...svc }, live });
    else actions.push({ kind: "ecs_service", resource_id: svc.id, action: "noop", desired: { ...svc }, live });
  }

  if (prune && !resourceFilter) {
    const pruneKinds = [
      ["iam_roles", "iam_role", managed.iam_roles.map((r) => r.id)],
      ["vpcs", "vpc", managed.vpcs.map((v) => v.id)],
      ["subnets", "subnet", managed.subnets.map((s) => s.id)],
      ["security_groups", "security_group", managed.security_groups.map((s) => s.id)],
      ["ebs_volumes", "ebs_volume", managed.ebs_volumes.map((v) => v.id)],
      ["ec2_instances", "ec2_instance", managed.ec2_instances.map((i) => i.id)],
      ["s3_buckets", "s3_bucket", managed.s3_buckets.map((b) => b.id)],
      ["ecs_clusters", "ecs_cluster", managed.ecs_clusters.map((c) => c.id)],
      ["ecs_services", "ecs_service", managed.ecs_services.map((s) => s.id)],
    ];
    for (const [liveKey, kind, desiredIds] of pruneKinds) {
      const liveMap = /** @type {Map<string, Record<string, unknown>>} */ (liveByKind[liveKey] ?? new Map());
      const desiredSet = new Set(desiredIds);
      for (const [id, live] of liveMap) {
        if (!desiredSet.has(id)) {
          actions.push({ kind: /** @type {AwsResourceKind} */ (kind), resource_id: id, action: "delete", live });
        }
      }
    }
  }

  return sortPlanActions(actions);
}
