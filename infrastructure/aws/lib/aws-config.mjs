/** HDC managed tag key applied to created AWS resources. */
export const HDC_MANAGED_TAG_KEY = "hdc:managed";
export const HDC_MANAGED_TAG_VALUE = "true";
export const HDC_RESOURCE_ID_TAG_KEY = "hdc:resource-id";

/**
 * @typedef {object} NormalizedIngressRule
 * @property {string} protocol
 * @property {number | null} from_port
 * @property {number | null} to_port
 * @property {string} cidr
 * @property {string} [description]
 */

/**
 * @typedef {object} NormalizedVpc
 * @property {string} id
 * @property {boolean} managed
 * @property {string} cidr
 * @property {boolean} enable_nat_gateway
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedSubnet
 * @property {string} id
 * @property {boolean} managed
 * @property {string} vpc_id
 * @property {string} cidr
 * @property {string} az
 * @property {boolean} public
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedSecurityGroup
 * @property {string} id
 * @property {boolean} managed
 * @property {string} vpc_id
 * @property {string} description
 * @property {NormalizedIngressRule[]} ingress
 * @property {NormalizedIngressRule[]} egress
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedIamRole
 * @property {string} id
 * @property {boolean} managed
 * @property {string} name
 * @property {"ec2" | "ecs-tasks"} trust
 * @property {string[]} managed_policy_arns
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedEbsVolume
 * @property {string} id
 * @property {boolean} managed
 * @property {number} size_gb
 * @property {string} volume_type
 * @property {string} [attach_to]
 * @property {string} [az]
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedEc2Instance
 * @property {string} id
 * @property {boolean} managed
 * @property {string} name
 * @property {string} instance_type
 * @property {string} ami
 * @property {string} subnet_id
 * @property {string[]} security_group_ids
 * @property {string | null} key_name
 * @property {string | null} user_data
 * @property {number} root_volume_gb
 * @property {string} root_volume_type
 * @property {string | null} iam_instance_profile
 * @property {NormalizedEbsVolume[]} ebs_volumes
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedS3Bucket
 * @property {string} id
 * @property {boolean} managed
 * @property {string} name
 * @property {boolean} versioning
 * @property {boolean} encryption
 * @property {number} estimated_size_gb
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedEcsContainer
 * @property {string} name
 * @property {string} image
 * @property {number} host_port
 * @property {number} container_port
 * @property {Record<string, string>} environment
 */

/**
 * @typedef {object} NormalizedEcsCluster
 * @property {string} id
 * @property {boolean} managed
 * @property {string} name
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedEcsService
 * @property {string} id
 * @property {boolean} managed
 * @property {string} cluster_id
 * @property {string} name
 * @property {number} cpu
 * @property {number} memory
 * @property {number} desired_count
 * @property {string[]} subnet_ids
 * @property {string[]} security_group_ids
 * @property {NormalizedEcsContainer[]} containers
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedAwsConfig
 * @property {number} schema_version
 * @property {string} region
 * @property {Record<string, string>} default_tags
 * @property {boolean} confirm_before_deploy
 * @property {number} hours_per_month
 * @property {NormalizedVpc[]} vpcs
 * @property {NormalizedSubnet[]} subnets
 * @property {NormalizedSecurityGroup[]} security_groups
 * @property {NormalizedIamRole[]} iam_roles
 * @property {NormalizedEbsVolume[]} ebs_volumes
 * @property {NormalizedEc2Instance[]} ec2_instances
 * @property {NormalizedS3Bucket[]} s3_buckets
 * @property {NormalizedEcsCluster[]} ecs_clusters
 * @property {NormalizedEcsService[]} ecs_services
 * @property {Map<string, NormalizedVpc>} vpcsById
 * @property {Map<string, NormalizedSubnet>} subnetsById
 * @property {Map<string, NormalizedSecurityGroup>} securityGroupsById
 * @property {Map<string, NormalizedIamRole>} iamRolesById
 * @property {Map<string, NormalizedEc2Instance>} ec2ById
 * @property {Map<string, NormalizedS3Bucket>} s3ById
 * @property {Map<string, NormalizedEcsCluster>} ecsClustersById
 * @property {Map<string, NormalizedEcsService>} ecsServicesById
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @param {string} fallback
 */
function str(v, fallback = "") {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/**
 * @param {unknown} tags
 * @param {Record<string, string>} defaults
 */
function normalizeTags(tags, defaults) {
  /** @type {Record<string, string>} */
  const out = { ...defaults };
  if (!isObject(tags)) return out;
  for (const [k, v] of Object.entries(tags)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * @param {unknown} list
 * @returns {NormalizedIngressRule[]}
 */
function normalizeIngressRules(list) {
  if (!Array.isArray(list)) return [];
  /** @type {NormalizedIngressRule[]} */
  const out = [];
  for (const item of list) {
    if (!isObject(item)) continue;
    const protocol = str(item.protocol, "tcp").toLowerCase();
    const fromPort =
      typeof item.from_port === "number"
        ? item.from_port
        : typeof item.fromPort === "number"
          ? item.fromPort
          : null;
    const toPort =
      typeof item.to_port === "number"
        ? item.to_port
        : typeof item.toPort === "number"
          ? item.toPort
          : fromPort;
    const cidr = str(item.cidr, "0.0.0.0/0");
    out.push({
      protocol,
      from_port: fromPort,
      to_port: toPort,
      cidr,
      description: str(item.description) || undefined,
    });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedVpc}
 */
function normalizeVpc(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("vpc entry must be an object");
  const id = str(raw.id);
  if (!id) throw new Error("vpcs[].id is required");
  const cidr = str(raw.cidr);
  if (!cidr) throw new Error(`vpcs[${id}].cidr is required`);
  return {
    id,
    managed: raw.managed !== false,
    cidr,
    enable_nat_gateway: raw.enable_nat_gateway === true || raw.enableNatGateway === true,
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id }),
  };
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedSubnet}
 */
function normalizeSubnet(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("subnet entry must be an object");
  const id = str(raw.id);
  const vpc_id = str(raw.vpc_id ?? raw.vpcId);
  const cidr = str(raw.cidr);
  const az = str(raw.az ?? raw.availability_zone);
  if (!id || !vpc_id || !cidr || !az) {
    throw new Error(`subnets[${id || "?"}] requires id, vpc_id, cidr, az`);
  }
  return {
    id,
    managed: raw.managed !== false,
    vpc_id,
    cidr,
    az,
    public: raw.public === true,
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id }),
  };
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedSecurityGroup}
 */
function normalizeSecurityGroup(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("security group entry must be an object");
  const id = str(raw.id);
  const vpc_id = str(raw.vpc_id ?? raw.vpcId);
  if (!id || !vpc_id) throw new Error(`security_groups[${id || "?"}] requires id and vpc_id`);
  const ingress = normalizeIngressRules(raw.ingress);
  const egress = normalizeIngressRules(raw.egress);
  if (!egress.length) {
    egress.push({ protocol: "-1", from_port: null, to_port: null, cidr: "0.0.0.0/0" });
  }
  return {
    id,
    managed: raw.managed !== false,
    vpc_id,
    description: str(raw.description, `HDC ${id}`),
    ingress,
    egress,
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id, Name: id }),
  };
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedIamRole}
 */
function normalizeIamRole(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("iam role entry must be an object");
  const id = str(raw.id);
  const name = str(raw.name, id);
  const trustRaw = str(raw.trust, "ec2");
  const trust = trustRaw === "ecs-tasks" ? "ecs-tasks" : "ec2";
  if (!id) throw new Error("iam_roles[].id is required");
  const policies = Array.isArray(raw.policies)
    ? raw.policies.map((p) => str(p)).filter(Boolean)
    : Array.isArray(raw.managed_policy_arns)
      ? raw.managed_policy_arns.map((p) => str(p)).filter(Boolean)
      : [];
  return {
    id,
    managed: raw.managed !== false,
    name,
    trust,
    managed_policy_arns: policies,
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id }),
  };
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedEbsVolume}
 */
function normalizeEbsVolume(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("ebs volume entry must be an object");
  const id = str(raw.id);
  if (!id) throw new Error("ebs_volumes[].id is required");
  const size_gb =
    typeof raw.size_gb === "number"
      ? raw.size_gb
      : typeof raw.sizeGb === "number"
        ? raw.sizeGb
        : 20;
  return {
    id,
    managed: raw.managed !== false,
    size_gb,
    volume_type: str(raw.volume_type ?? raw.volumeType, "gp3"),
    attach_to: str(raw.attach_to ?? raw.attachTo) || undefined,
    az: str(raw.az) || undefined,
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id }),
  };
}

/**
 * @param {unknown} list
 * @param {Record<string, string>} defaultTags
 */
function normalizeNestedEbs(list, defaultTags) {
  if (!Array.isArray(list)) return [];
  return list.map((v) => normalizeEbsVolume(v, defaultTags));
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedEc2Instance}
 */
function normalizeEc2Instance(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("ec2 instance entry must be an object");
  const id = str(raw.id);
  const instance_type = str(raw.instance_type ?? raw.instanceType);
  const ami = str(raw.ami);
  const subnet_id = str(raw.subnet_id ?? raw.subnetId);
  if (!id || !instance_type || !ami || !subnet_id) {
    throw new Error(`ec2_instances[${id || "?"}] requires id, instance_type, ami, subnet_id`);
  }
  const sgIds = Array.isArray(raw.security_group_ids)
    ? raw.security_group_ids.map((s) => str(s)).filter(Boolean)
    : Array.isArray(raw.securityGroupIds)
      ? raw.securityGroupIds.map((s) => str(s)).filter(Boolean)
      : [];
  const root_volume_gb =
    typeof raw.root_volume_gb === "number"
      ? raw.root_volume_gb
      : typeof raw.rootVolumeGb === "number"
        ? raw.rootVolumeGb
        : 30;
  return {
    id,
    managed: raw.managed !== false,
    name: str(raw.name, id),
    instance_type,
    ami,
    subnet_id,
    security_group_ids: sgIds,
    key_name: str(raw.key_name ?? raw.keyName) || null,
    user_data: str(raw.user_data ?? raw.userData) || null,
    root_volume_gb,
    root_volume_type: str(raw.root_volume_type ?? raw.rootVolumeType, "gp3"),
    iam_instance_profile: str(raw.iam_instance_profile ?? raw.iamInstanceProfile) || null,
    ebs_volumes: normalizeNestedEbs(raw.ebs_volumes ?? raw.ebsVolumes, defaultTags),
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id, Name: str(raw.name, id) }),
  };
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedS3Bucket}
 */
function normalizeS3Bucket(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("s3 bucket entry must be an object");
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) throw new Error("s3_buckets[] requires id and name");
  const estimated =
    typeof raw.estimated_size_gb === "number"
      ? raw.estimated_size_gb
      : typeof raw.estimatedSizeGb === "number"
        ? raw.estimatedSizeGb
        : 10;
  return {
    id,
    managed: raw.managed !== false,
    name,
    versioning: raw.versioning === true,
    encryption: raw.encryption !== false,
    estimated_size_gb: estimated,
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id }),
  };
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedEcsCluster}
 */
function normalizeEcsCluster(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("ecs cluster entry must be an object");
  const id = str(raw.id);
  const name = str(raw.name, id);
  if (!id) throw new Error("ecs_clusters[].id is required");
  return {
    id,
    managed: raw.managed !== false,
    name,
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id }),
  };
}

/**
 * @param {unknown} raw
 * @returns {NormalizedEcsContainer[]}
 */
function normalizeEcsContainers(raw) {
  const td = isObject(raw) ? raw.task_definition ?? raw.taskDefinition ?? raw : raw;
  const containers = isObject(td) ? td.containers ?? td.container_definitions : null;
  if (!Array.isArray(containers)) return [];
  /** @type {NormalizedEcsContainer[]} */
  const out = [];
  for (const c of containers) {
    if (!isObject(c)) continue;
    const name = str(c.name, "app");
    const image = str(c.image);
    if (!image) continue;
    const ports = Array.isArray(c.port_mappings)
      ? c.port_mappings
      : Array.isArray(c.portMappings)
        ? c.portMappings
        : [];
    let host_port = 0;
    let container_port = 80;
    if (ports.length && isObject(ports[0])) {
      host_port = typeof ports[0].host_port === "number" ? ports[0].host_port : typeof ports[0].hostPort === "number" ? ports[0].hostPort : 0;
      container_port =
        typeof ports[0].container_port === "number"
          ? ports[0].container_port
          : typeof ports[0].containerPort === "number"
            ? ports[0].containerPort
            : 80;
    }
    /** @type {Record<string, string>} */
    const environment = {};
    const envList = Array.isArray(c.environment) ? c.environment : [];
    for (const e of envList) {
      if (!isObject(e)) continue;
      const k = str(e.name);
      const v = typeof e.value === "string" ? e.value : "";
      if (k) environment[k] = v;
    }
    out.push({ name, image, host_port, container_port, environment });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultTags
 * @returns {NormalizedEcsService}
 */
function normalizeEcsService(raw, defaultTags) {
  if (!isObject(raw)) throw new Error("ecs service entry must be an object");
  const id = str(raw.id);
  const cluster_id = str(raw.cluster_id ?? raw.clusterId);
  const name = str(raw.name, id);
  if (!id || !cluster_id) throw new Error(`ecs_services[${id || "?"}] requires id and cluster_id`);
  const cpu = typeof raw.cpu === "number" ? raw.cpu : 256;
  const memory = typeof raw.memory === "number" ? raw.memory : 512;
  const desired_count =
    typeof raw.desired_count === "number"
      ? raw.desired_count
      : typeof raw.desiredCount === "number"
        ? raw.desiredCount
        : 1;
  const subnet_ids = Array.isArray(raw.subnet_ids)
    ? raw.subnet_ids.map((s) => str(s)).filter(Boolean)
    : Array.isArray(raw.subnetIds)
      ? raw.subnetIds.map((s) => str(s)).filter(Boolean)
      : [];
  const security_group_ids = Array.isArray(raw.security_group_ids)
    ? raw.security_group_ids.map((s) => str(s)).filter(Boolean)
    : Array.isArray(raw.securityGroupIds)
      ? raw.securityGroupIds.map((s) => str(s)).filter(Boolean)
      : [];
  return {
    id,
    managed: raw.managed !== false,
    cluster_id,
    name,
    cpu,
    memory,
    desired_count,
    subnet_ids,
    security_group_ids,
    containers: normalizeEcsContainers(raw),
    tags: normalizeTags(raw.tags, { ...defaultTags, [HDC_RESOURCE_ID_TAG_KEY]: id, Name: name }),
  };
}

/**
 * @param {unknown} cfg
 * @returns {NormalizedAwsConfig}
 */
export function normalizeAwsConfig(cfg) {
  if (!isObject(cfg)) throw new Error("AWS config must be an object");
  const awsBlock = isObject(cfg.aws) ? cfg.aws : {};
  const costBlock = isObject(cfg.cost) ? cfg.cost : {};
  const region = str(awsBlock.region ?? cfg.region);
  if (!region) throw new Error("aws.region is required in config");
  const default_tags = normalizeTags(awsBlock.default_tags ?? awsBlock.defaultTags, {
    [HDC_MANAGED_TAG_KEY]: HDC_MANAGED_TAG_VALUE,
  });
  const confirm_before_deploy = costBlock.confirm_before_deploy !== false;
  const hours_per_month =
    typeof costBlock.hours_per_month === "number" && costBlock.hours_per_month > 0
      ? costBlock.hours_per_month
      : 730;

  const vpcs = (Array.isArray(cfg.vpcs) ? cfg.vpcs : []).map((v) => normalizeVpc(v, default_tags));
  const subnets = (Array.isArray(cfg.subnets) ? cfg.subnets : []).map((s) =>
    normalizeSubnet(s, default_tags),
  );
  const security_groups = (Array.isArray(cfg.security_groups) ? cfg.security_groups : []).map((s) =>
    normalizeSecurityGroup(s, default_tags),
  );
  const iam_roles = (Array.isArray(cfg.iam_roles) ? cfg.iam_roles : []).map((r) =>
    normalizeIamRole(r, default_tags),
  );
  const ebs_volumes = (Array.isArray(cfg.ebs_volumes) ? cfg.ebs_volumes : []).map((v) =>
    normalizeEbsVolume(v, default_tags),
  );
  const ec2_instances = (Array.isArray(cfg.ec2_instances) ? cfg.ec2_instances : []).map((i) =>
    normalizeEc2Instance(i, default_tags),
  );
  const s3_buckets = (Array.isArray(cfg.s3_buckets) ? cfg.s3_buckets : []).map((b) =>
    normalizeS3Bucket(b, default_tags),
  );
  const ecs_clusters = (Array.isArray(cfg.ecs_clusters) ? cfg.ecs_clusters : []).map((c) =>
    normalizeEcsCluster(c, default_tags),
  );
  const ecs_services = (Array.isArray(cfg.ecs_services) ? cfg.ecs_services : []).map((s) =>
    normalizeEcsService(s, default_tags),
  );

  /** @type {(arr: { id: string }[]) => Map<string, any>} */
  const toMap = (arr) => new Map(arr.map((x) => [x.id, x]));

  return {
    schema_version: typeof cfg.schema_version === "number" ? cfg.schema_version : 1,
    region,
    default_tags,
    confirm_before_deploy,
    hours_per_month,
    vpcs,
    subnets,
    security_groups,
    iam_roles,
    ebs_volumes,
    ec2_instances,
    s3_buckets,
    ecs_clusters,
    ecs_services,
    vpcsById: toMap(vpcs),
    subnetsById: toMap(subnets),
    securityGroupsById: toMap(security_groups),
    iamRolesById: toMap(iam_roles),
    ec2ById: toMap(ec2_instances),
    s3ById: toMap(s3_buckets),
    ecsClustersById: toMap(ecs_clusters),
    ecsServicesById: toMap(ecs_services),
  };
}

/**
 * @param {NormalizedAwsConfig} config
 * @param {string} [resourceFilter]
 */
export function managedResources(config, resourceFilter) {
  if (resourceFilter) {
    return {
      vpcs: config.vpcs.filter((v) => v.managed && v.id === resourceFilter),
      subnets: config.subnets.filter((s) => s.managed && s.id === resourceFilter),
      security_groups: config.security_groups.filter((s) => s.managed && s.id === resourceFilter),
      iam_roles: config.iam_roles.filter((r) => r.managed && r.id === resourceFilter),
      ebs_volumes: config.ebs_volumes.filter((v) => v.managed && v.id === resourceFilter),
      ec2_instances: config.ec2_instances.filter((i) => i.managed && i.id === resourceFilter),
      s3_buckets: config.s3_buckets.filter((b) => b.managed && b.id === resourceFilter),
      ecs_clusters: config.ecs_clusters.filter((c) => c.managed && c.id === resourceFilter),
      ecs_services: config.ecs_services.filter((s) => s.managed && s.id === resourceFilter),
    };
  }
  return {
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
}
