import { parseAwsXmlItems } from "./aws-api.mjs";
import { HDC_MANAGED_TAG_KEY, HDC_MANAGED_TAG_VALUE } from "./aws-config.mjs";

/** @typedef {ReturnType<import("./aws-api.mjs").createAwsClient>} AwsClient */
/** @typedef {import("./aws-config.mjs").NormalizedEc2Instance} NormalizedEc2Instance */
/** @typedef {import("./aws-config.mjs").NormalizedEbsVolume} NormalizedEbsVolume */
/** @typedef {import("./aws-config.mjs").NormalizedIamRole} NormalizedIamRole */
/** @typedef {import("./aws-plan.mjs").AwsPlanAction} AwsPlanAction */

/**
 * @param {Record<string, string>} tags
 */
function instanceTagParams(tags) {
  /** @type {Record<string, string>} */
  const out = { "TagSpecification.1.ResourceType": "instance" };
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
 * @param {NormalizedIamRole} role
 * @param {boolean} dryRun
 */
export async function createIamRole(client, role, dryRun) {
  const trustPolicy =
    role.trust === "ecs-tasks"
      ? JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
        })
      : JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
        });

  await client.iam("CreateRole", {
    RoleName: role.name,
    AssumeRolePolicyDocument: encodeURIComponent(trustPolicy),
  });

  for (let i = 0; i < role.managed_policy_arns.length; i++) {
    await client.iam("AttachRolePolicy", {
      RoleName: role.name,
      PolicyArn: role.managed_policy_arns[i],
    });
  }

  if (role.trust === "ec2") {
    await client.iam("CreateInstanceProfile", { InstanceProfileName: role.name });
    await client.iam("AddRoleToInstanceProfile", {
      InstanceProfileName: role.name,
      RoleName: role.name,
    });
  }

  return { aws_id: role.name, resource_id: role.id };
}

/**
 * @param {AwsClient} client
 * @param {NormalizedEbsVolume} vol
 * @param {boolean} dryRun
 */
export async function createEbsVolume(client, vol, dryRun) {
  const params = {
    Size: vol.size_gb,
    VolumeType: vol.volume_type,
    AvailabilityZone: vol.az ?? `${client.region}a`,
    ...(() => {
      /** @type {Record<string, string>} */
      const out = { "TagSpecification.1.ResourceType": "volume" };
      let i = 1;
      for (const [key, value] of Object.entries({ ...vol.tags, [HDC_MANAGED_TAG_KEY]: HDC_MANAGED_TAG_VALUE })) {
        out[`TagSpecification.1.Tag.${i}.Key`] = key;
        out[`TagSpecification.1.Tag.${i}.Value`] = value;
        i++;
      }
      return out;
    })(),
    DryRun: dryRun,
  };
  const xml = await client.ec2("CreateVolume", params);
  const items = parseAwsXmlItems(xml, "volume");
  const volumeId = items[0]?.volumeId;
  if (!volumeId) throw new Error(`CreateVolume failed for ${vol.id}`);
  return { aws_id: volumeId, resource_id: vol.id };
}

/**
 * @param {AwsClient} client
 * @param {string} subnetAwsId
 * @param {NormalizedEc2Instance} inst
 * @param {Map<string, string>} sgIdMap
 * @param {boolean} dryRun
 */
export async function createEc2Instance(client, subnetAwsId, inst, sgIdMap, dryRun) {
  /** @type {Record<string, string | number | boolean | string[]>} */
  const params = {
    ImageId: inst.ami,
    InstanceType: inst.instance_type,
    MinCount: 1,
    MaxCount: 1,
    SubnetId: subnetAwsId,
    ...instanceTagParams({ ...inst.tags, [HDC_MANAGED_TAG_KEY]: HDC_MANAGED_TAG_VALUE }),
    DryRun: dryRun,
  };
  if (inst.key_name) params.KeyName = inst.key_name;
  if (inst.user_data) params.UserData = Buffer.from(inst.user_data).toString("base64");
  if (inst.iam_instance_profile) params.IamInstanceProfile = { Name: inst.iam_instance_profile };

  const sgIds = inst.security_group_ids.map((id) => sgIdMap.get(id) ?? id).filter(Boolean);
  if (sgIds.length) {
    sgIds.forEach((id, idx) => {
      params[`SecurityGroupId.${idx + 1}`] = id;
    });
  }

  params["BlockDeviceMapping.1.DeviceName"] = "/dev/sda1";
  params["BlockDeviceMapping.1.Ebs.VolumeSize"] = inst.root_volume_gb;
  params["BlockDeviceMapping.1.Ebs.VolumeType"] = inst.root_volume_type;
  params["BlockDeviceMapping.1.Ebs.DeleteOnTermination"] = true;

  const xml = await client.ec2("RunInstances", params);
  const items = parseAwsXmlItems(xml, "item");
  const instanceId = items.find((x) => x.instanceId)?.instanceId;
  if (!instanceId) throw new Error(`RunInstances failed for ${inst.id}`);
  return {
    aws_id: instanceId,
    resource_id: inst.id,
    private_ip: items.find((x) => x.privateIpAddress)?.privateIpAddress,
  };
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 * @param {Map<string, string>} subnetIdMap
 * @param {Map<string, string>} sgIdMap
 * @param {Map<string, string>} idMap
 * @param {boolean} dryRun
 */
export async function applyEc2Action(client, action, subnetIdMap, sgIdMap, idMap, dryRun) {
  const d = /** @type {NormalizedEc2Instance} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    const subnetAwsId = subnetIdMap.get(d.subnet_id);
    if (!subnetAwsId) throw new Error(`Subnet not found for EC2 ${d.id}`);
    const res = await createEc2Instance(client, subnetAwsId, d, sgIdMap, dryRun);
    idMap.set(d.id, res.aws_id);
    return res;
  }
  if (action.action === "delete" && action.live?.aws_id) {
    await client.ec2("TerminateInstances", { "InstanceId.1": String(action.live.aws_id) });
    return { resource_id: action.resource_id, deleted: true };
  }
  return null;
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 * @param {Map<string, string>} idMap
 * @param {boolean} dryRun
 */
export async function applyEbsAction(client, action, idMap, dryRun) {
  const d = /** @type {NormalizedEbsVolume} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    const res = await createEbsVolume(client, d, dryRun);
    idMap.set(d.id, res.aws_id);
    return res;
  }
  if (action.action === "delete" && action.live?.aws_id) {
    await client.ec2("DeleteVolume", { VolumeId: String(action.live.aws_id) });
    return { resource_id: action.resource_id, deleted: true };
  }
  return null;
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 */
export async function applyIamAction(client, action) {
  const d = /** @type {NormalizedIamRole} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    return createIamRole(client, d, false);
  }
  if (action.action === "delete" && action.live?.aws_id) {
    const name = String(action.live.aws_id);
    try {
      await client.iam("DeleteInstanceProfile", { InstanceProfileName: name });
    } catch {
      // may not exist
    }
    await client.iam("DeleteRole", { RoleName: name });
    return { resource_id: action.resource_id, deleted: true };
  }
  return null;
}
