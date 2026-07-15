import { parseAwsXmlItems } from "./aws-api.mjs";
import { HDC_RESOURCE_ID_TAG_KEY } from "./aws-config.mjs";

/**
 * @param {string} xml
 * @param {string} tagName
 */
function tagValueFromXml(xml, tagName) {
  const re = new RegExp(`<key>${tagName}</key>\\s*<value>([^<]*)</value>`, "i");
  const alt = new RegExp(`<Key>${tagName}</Key>\\s*<Value>([^<]*)</Value>`, "i");
  const m = xml.match(re) ?? xml.match(alt);
  return m ? m[1] : null;
}

/**
 * @param {string} itemXml
 */
function hdcResourceIdFromItem(itemXml) {
  const tagBlocks = itemXml.match(/<tagSet>[\s\S]*?<\/tagSet>/gi) ?? [];
  for (const block of tagBlocks) {
    const id = tagValueFromXml(block, HDC_RESOURCE_ID_TAG_KEY);
    if (id) return id;
  }
  const setBlocks = itemXml.match(/<TagSet>[\s\S]*?<\/TagSet>/gi) ?? [];
  for (const block of setBlocks) {
    const id = tagValueFromXml(block, HDC_RESOURCE_ID_TAG_KEY);
    if (id) return id;
  }
  return null;
}

/**
 * @param {ReturnType<import("./aws-api.mjs").createAwsClient>} client
 */
export async function collectAwsLiveState(client) {
  /** @type {Record<string, Map<string, Record<string, unknown>>>} */
  const liveByKind = {
    iam_roles: new Map(),
    vpcs: new Map(),
    subnets: new Map(),
    security_groups: new Map(),
    ebs_volumes: new Map(),
    ec2_instances: new Map(),
    s3_buckets: new Map(),
    ecs_clusters: new Map(),
    ecs_services: new Map(),
  };

  const vpcXml = await client.ec2("DescribeVpcs", { "Filter.1.Name": "tag:hdc:managed", "Filter.1.Value.1": "true" });
  const vpcItems = parseAwsXmlItems(vpcXml, "item");
  for (const item of vpcItems) {
    const itemStr = Object.entries(item).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    const rid = hdcResourceIdFromItem(itemStr) ?? item.vpcId;
    if (!rid) continue;
    liveByKind.vpcs.set(rid, {
      id: rid,
      aws_id: item.vpcId,
      cidr: item.cidrBlock,
      state: item.state,
    });
  }

  const subnetXml = await client.ec2("DescribeSubnets", { "Filter.1.Name": "tag:hdc:managed", "Filter.1.Value.1": "true" });
  for (const item of parseAwsXmlItems(subnetXml, "item")) {
    const itemStr = Object.entries(item).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    const rid = hdcResourceIdFromItem(itemStr) ?? item.subnetId;
    if (!rid) continue;
    liveByKind.subnets.set(rid, {
      id: rid,
      aws_id: item.subnetId,
      vpc_id: item.vpcId,
      cidr: item.cidrBlock,
      az: item.availabilityZone,
    });
  }

  const sgXml = await client.ec2("DescribeSecurityGroups", {
    "Filter.1.Name": "tag:hdc:managed",
    "Filter.1.Value.1": "true",
  });
  for (const item of parseAwsXmlItems(sgXml, "item")) {
    const itemStr = Object.entries(item).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    const rid = hdcResourceIdFromItem(itemStr) ?? item.groupId;
    if (!rid) continue;
    liveByKind.security_groups.set(rid, {
      id: rid,
      aws_id: item.groupId,
      vpc_id: item.vpcId,
      description: item.groupDescription,
    });
  }

  const volXml = await client.ec2("DescribeVolumes", { "Filter.1.Name": "tag:hdc:managed", "Filter.1.Value.1": "true" });
  for (const item of parseAwsXmlItems(volXml, "item")) {
    const itemStr = Object.entries(item).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    const rid = hdcResourceIdFromItem(itemStr) ?? item.volumeId;
    if (!rid) continue;
    liveByKind.ebs_volumes.set(rid, {
      id: rid,
      aws_id: item.volumeId,
      size_gb: Number(item.size),
      volume_type: item.volumeType,
      state: item.status,
    });
  }

  const instXml = await client.ec2("DescribeInstances", {
    "Filter.1.Name": "tag:hdc:managed",
    "Filter.1.Value.1": "true",
  });
  for (const item of parseAwsXmlItems(instXml, "item")) {
    const itemStr = Object.entries(item).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    const rid = hdcResourceIdFromItem(itemStr) ?? item.instanceId;
    if (!rid) continue;
    liveByKind.ec2_instances.set(rid, {
      id: rid,
      aws_id: item.instanceId,
      instance_type: item.instanceType,
      state: item.instanceState?.name ?? item.state,
      private_ip: item.privateIpAddress,
      public_ip: item.publicIpAddress,
    });
  }

  const clusterXml = await client.ecs("DescribeClusters", { clusters: [] });
  for (const item of parseAwsXmlItems(clusterXml, "cluster")) {
    const name = item.clusterName;
    if (!name) continue;
    liveByKind.ecs_clusters.set(name, {
      id: name,
      aws_id: item.clusterArn,
      name,
      status: item.status,
    });
  }

  const clusters = [...liveByKind.ecs_clusters.values()].map((c) => c.name).filter(Boolean);
  if (clusters.length) {
    const svcXml = await client.ecs("ListServices", { cluster: String(clusters[0]) });
    const arns = parseAwsXmlItems(svcXml, "serviceArn").map((x) => x.serviceArn ?? Object.values(x)[0]).filter(Boolean);
    if (arns.length) {
      const descXml = await client.ecs("DescribeServices", { cluster: String(clusters[0]), services: arns });
      for (const item of parseAwsXmlItems(descXml, "service")) {
        const name = item.serviceName;
        if (!name) continue;
        liveByKind.ecs_services.set(name, {
          id: name,
          aws_id: item.serviceArn,
          name,
          desired_count: Number(item.desiredCount ?? 1),
          status: item.status,
        });
      }
    }
  }

  // S3 — list buckets and match tags via config ids is done at diff time; HEAD bucket for existence
  try {
    const listXml = await client.queryRequest("s3", "s3.amazonaws.com", "ListBuckets", {}, "2006-03-01");
    for (const item of parseAwsXmlItems(listXml, "Bucket")) {
      const name = item.Name ?? item.name;
      if (!name) continue;
      liveByKind.s3_buckets.set(name, { id: name, name, aws_id: name });
    }
  } catch {
    // ListBuckets may need us-east-1 global endpoint; skip on failure
  }

  return liveByKind;
}

/**
 * @param {NormalizedAwsConfig} config
 * @param {Record<string, Map<string, Record<string, unknown>>>} liveByKind
 */
export function diffAwsState(config, liveByKind) {
  /** @type {{ kind: string; resource_id: string; status: string; detail?: string }[]} */
  const diffs = [];

  const check = (kind, key, desired, idField = "id") => {
    const liveMap = liveByKind[key] ?? new Map();
    for (const d of desired) {
      const live = liveMap.get(d[idField]);
      diffs.push({
        kind,
        resource_id: d[idField],
        status: live ? "present" : "missing",
        detail: live ? undefined : "not in AWS",
      });
    }
    for (const [id] of liveMap) {
      if (!desired.find((d) => d[idField] === id)) {
        diffs.push({ kind, resource_id: id, status: "extra", detail: "in AWS but not in config" });
      }
    }
  };

  check("vpc", "vpcs", config.vpcs.filter((v) => v.managed));
  check("subnet", "subnets", config.subnets.filter((s) => s.managed));
  check("security_group", "security_groups", config.security_groups.filter((s) => s.managed));
  check("iam_role", "iam_roles", config.iam_roles.filter((r) => r.managed));
  check("ebs_volume", "ebs_volumes", config.ebs_volumes.filter((v) => v.managed));
  check("ec2_instance", "ec2_instances", config.ec2_instances.filter((i) => i.managed));
  check("s3_bucket", "s3_buckets", config.s3_buckets.filter((b) => b.managed), "name");
  check("ecs_cluster", "ecs_clusters", config.ecs_clusters.filter((c) => c.managed));
  check("ecs_service", "ecs_services", config.ecs_services.filter((s) => s.managed));

  return diffs;
}

/** @typedef {import("./aws-config.mjs").NormalizedAwsConfig} NormalizedAwsConfig */
