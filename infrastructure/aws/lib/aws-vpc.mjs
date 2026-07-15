import { HDC_MANAGED_TAG_KEY, HDC_MANAGED_TAG_VALUE } from "./aws-config.mjs";

/** @typedef {import("./aws-api.mjs").createAwsClient} AwsClientFactory */
/** @typedef {ReturnType<AwsClientFactory>} AwsClient */
/** @typedef {import("./aws-config.mjs").NormalizedVpc} NormalizedVpc */
/** @typedef {import("./aws-config.mjs").NormalizedSubnet} NormalizedSubnet */
/** @typedef {import("./aws-config.mjs").NormalizedSecurityGroup} NormalizedSecurityGroup */
/** @typedef {import("./aws-plan.mjs").AwsPlanAction} AwsPlanAction */

import { parseAwsXmlItems } from "./aws-api.mjs";

/**
 * @param {Record<string, string>} tags
 * @param {string} resourceType
 */
function tagParams(tags, resourceType) {
  /** @type {Record<string, string>} */
  const out = { "TagSpecification.1.ResourceType": resourceType };
  let i = 1;
  for (const [key, value] of Object.entries(tags)) {
    out[`TagSpecification.1.Tag.${i}.Key`] = key;
    out[`TagSpecification.1.Tag.${i}.Value`] = value;
    i++;
  }
  return out;
}

/**
 * @param {AwsClient} client
 * @param {NormalizedVpc} vpc
 * @param {boolean} dryRun
 */
export async function createVpc(client, vpc, dryRun) {
  const params = {
    CidrBlock: vpc.cidr,
    ...tagParams({ ...vpc.tags, [HDC_MANAGED_TAG_KEY]: HDC_MANAGED_TAG_VALUE }, "vpc"),
    DryRun: dryRun,
  };
  const xml = await client.ec2("CreateVpc", params);
  const items = parseAwsXmlItems(xml, "vpc");
  const vpcId = items[0]?.vpcId;
  if (!vpcId) throw new Error(`CreateVpc failed for ${vpc.id}`);
  return { aws_id: vpcId, resource_id: vpc.id };
}

/**
 * @param {AwsClient} client
 * @param {string} vpcAwsId
 * @param {NormalizedSubnet} subnet
 * @param {boolean} dryRun
 */
export async function createSubnet(client, vpcAwsId, subnet, dryRun) {
  const params = {
    VpcId: vpcAwsId,
    CidrBlock: subnet.cidr,
    AvailabilityZone: subnet.az,
    ...tagParams({ ...subnet.tags, [HDC_MANAGED_TAG_KEY]: HDC_MANAGED_TAG_VALUE }, "subnet"),
    DryRun: dryRun,
  };
  const xml = await client.ec2("CreateSubnet", params);
  const items = parseAwsXmlItems(xml, "subnet");
  const subnetId = items[0]?.subnetId;
  if (!subnetId) throw new Error(`CreateSubnet failed for ${subnet.id}`);
  return { aws_id: subnetId, resource_id: subnet.id };
}

/**
 * @param {AwsClient} client
 * @param {string} vpcAwsId
 * @param {NormalizedSecurityGroup} sg
 * @param {boolean} dryRun
 */
export async function createSecurityGroup(client, vpcAwsId, sg, dryRun) {
  const params = {
    GroupName: sg.id,
    Description: sg.description,
    VpcId: vpcAwsId,
    ...tagParams({ ...sg.tags, [HDC_MANAGED_TAG_KEY]: HDC_MANAGED_TAG_VALUE }, "security-group"),
    DryRun: dryRun,
  };
  const xml = await client.ec2("CreateSecurityGroup", params);
  const items = parseAwsXmlItems(xml, "securityGroupInfo");
  const groupId = items[0]?.groupId ?? parseAwsXmlItems(xml, "item")[0]?.groupId;
  if (!groupId) throw new Error(`CreateSecurityGroup failed for ${sg.id}`);

  for (const rule of sg.ingress) {
    if (rule.protocol === "-1") {
      await client.ec2("AuthorizeSecurityGroupIngress", {
        GroupId: groupId,
        IpProtocol: "-1",
        CidrIp: rule.cidr,
        DryRun: dryRun,
      });
    } else {
      await client.ec2("AuthorizeSecurityGroupIngress", {
        GroupId: groupId,
        IpProtocol: rule.protocol,
        FromPort: rule.from_port ?? 0,
        ToPort: rule.to_port ?? rule.from_port ?? 0,
        CidrIp: rule.cidr,
        DryRun: dryRun,
      });
    }
  }

  return { aws_id: groupId, resource_id: sg.id };
}

/**
 * @param {AwsClient} client
 * @param {string} resourceIdTag
 */
export async function resolveVpcIdByTag(client, resourceIdTag) {
  const xml = await client.ec2("DescribeVpcs", {
    "Filter.1.Name": `tag:${HDC_MANAGED_TAG_KEY}`,
    "Filter.1.Value.1": HDC_MANAGED_TAG_VALUE,
    "Filter.2.Name": `tag:hdc:resource-id`,
    "Filter.2.Value.1": resourceIdTag,
  });
  const items = parseAwsXmlItems(xml, "item");
  return items[0]?.vpcId ?? null;
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 * @param {Map<string, string>} idMap config id → aws id
 * @param {boolean} dryRun
 */
export async function applyVpcAction(client, action, idMap, dryRun) {
  const d = /** @type {NormalizedVpc} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    const res = await createVpc(client, d, dryRun);
    idMap.set(d.id, res.aws_id);
    return res;
  }
  return null;
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 * @param {Map<string, string>} vpcIdMap
 * @param {Map<string, string>} idMap
 * @param {boolean} dryRun
 */
export async function applySubnetAction(client, action, vpcIdMap, idMap, dryRun) {
  const d = /** @type {NormalizedSubnet} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    let vpcAwsId = vpcIdMap.get(d.vpc_id);
    if (!vpcAwsId) vpcAwsId = await resolveVpcIdByTag(client, d.vpc_id);
    if (!vpcAwsId) throw new Error(`VPC not found for subnet ${d.id} (vpc_id ${d.vpc_id})`);
    const res = await createSubnet(client, vpcAwsId, d, dryRun);
    idMap.set(d.id, res.aws_id);
    return res;
  }
  return null;
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 * @param {Map<string, string>} vpcIdMap
 * @param {Map<string, string>} idMap
 * @param {boolean} dryRun
 */
export async function applySecurityGroupAction(client, action, vpcIdMap, idMap, dryRun) {
  const d = /** @type {NormalizedSecurityGroup} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    let vpcAwsId = vpcIdMap.get(d.vpc_id);
    if (!vpcAwsId) vpcAwsId = await resolveVpcIdByTag(client, d.vpc_id);
    if (!vpcAwsId) throw new Error(`VPC not found for security group ${d.id}`);
    const res = await createSecurityGroup(client, vpcAwsId, d, dryRun);
    idMap.set(d.id, res.aws_id);
    return res;
  }
  return null;
}
