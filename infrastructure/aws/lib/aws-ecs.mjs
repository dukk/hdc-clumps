import { parseAwsXmlItems } from "./aws-api.mjs";

/** @typedef {ReturnType<import("./aws-api.mjs").createAwsClient>} AwsClient */
/** @typedef {import("./aws-config.mjs").NormalizedEcsCluster} NormalizedEcsCluster */
/** @typedef {import("./aws-config.mjs").NormalizedEcsService} NormalizedEcsService */
/** @typedef {import("./aws-plan.mjs").AwsPlanAction} AwsPlanAction */

/**
 * @param {AwsClient} client
 * @param {NormalizedEcsCluster} cluster
 */
export async function createEcsCluster(client, cluster) {
  const xml = await client.ecs("CreateCluster", { clusterName: cluster.name });
  const items = parseAwsXmlItems(xml, "cluster");
  const arn = items[0]?.clusterArn;
  return { aws_id: arn ?? cluster.name, resource_id: cluster.id };
}

/**
 * @param {NormalizedEcsService} svc
 */
function buildTaskDefinitionJson(svc) {
  const container = svc.containers[0];
  return {
    family: svc.name,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: String(svc.cpu),
    memory: String(svc.memory),
    containerDefinitions: svc.containers.map((c) => ({
      name: c.name,
      image: c.image,
      essential: true,
      portMappings:
        c.container_port > 0
          ? [{ containerPort: c.container_port, hostPort: c.host_port || c.container_port, protocol: "tcp" }]
          : [],
      environment: Object.entries(c.environment).map(([name, value]) => ({ name, value })),
    })),
  };
}

/**
 * @param {AwsClient} client
 * @param {string} clusterName
 * @param {NormalizedEcsService} svc
 * @param {string[]} subnetAwsIds
 * @param {string[]} sgAwsIds
 */
export async function createEcsService(client, clusterName, svc, subnetAwsIds, sgAwsIds) {
  const td = buildTaskDefinitionJson(svc);
  const regXml = await client.ecs("RegisterTaskDefinition", {
    family: td.family,
    networkMode: td.networkMode,
    requiresCompatibilities: td.requiresCompatibilities,
    cpu: td.cpu,
    memory: td.memory,
    containerDefinitions: JSON.stringify(td.containerDefinitions),
  });
  const tdItems = parseAwsXmlItems(regXml, "taskDefinition");
  const tdArn = tdItems[0]?.taskDefinitionArn;
  if (!tdArn) throw new Error(`RegisterTaskDefinition failed for ${svc.id}`);

  const params = {
    cluster: clusterName,
    serviceName: svc.name,
    taskDefinition: tdArn,
    desiredCount: svc.desired_count,
    launchType: "FARGATE",
    networkConfiguration: JSON.stringify({
      awsvpcConfiguration: {
        subnets: subnetAwsIds,
        securityGroups: sgAwsIds,
        assignPublicIp: "ENABLED",
      },
    }),
  };
  const xml = await client.ecs("CreateService", params);
  const items = parseAwsXmlItems(xml, "service");
  return { aws_id: items[0]?.serviceArn ?? svc.name, resource_id: svc.id, task_definition: tdArn };
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 * @param {Map<string, string>} clusterIdMap
 * @param {Map<string, string>} subnetIdMap
 * @param {Map<string, string>} sgIdMap
 */
export async function applyEcsClusterAction(client, action, clusterIdMap) {
  const d = /** @type {NormalizedEcsCluster} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    const res = await createEcsCluster(client, d);
    clusterIdMap.set(d.id, d.name);
    return res;
  }
  if (action.action === "delete" && action.live?.aws_id) {
    await client.ecs("DeleteCluster", { cluster: String(action.live.name ?? action.live.aws_id) });
    return { resource_id: action.resource_id, deleted: true };
  }
  return null;
}

/**
 * @param {AwsClient} client
 * @param {AwsPlanAction} action
 * @param {Map<string, string>} clusterIdMap
 * @param {Map<string, string>} subnetIdMap
 * @param {Map<string, string>} sgIdMap
 */
export async function applyEcsServiceAction(client, action, clusterIdMap, subnetIdMap, sgIdMap) {
  const d = /** @type {NormalizedEcsService} */ (/** @type {Record<string, unknown>} */ (action.desired));
  if (action.action === "create") {
    const clusterName = clusterIdMap.get(d.cluster_id) ?? d.cluster_id;
    const subnetAwsIds = d.subnet_ids.map((id) => subnetIdMap.get(id) ?? id);
    const sgAwsIds = d.security_group_ids.map((id) => sgIdMap.get(id) ?? id);
    return createEcsService(client, clusterName, d, subnetAwsIds, sgAwsIds);
  }
  if (action.action === "update") {
    const clusterName = clusterIdMap.get(d.cluster_id) ?? d.cluster_id;
    const subnetAwsIds = d.subnet_ids.map((id) => subnetIdMap.get(id) ?? id);
    const sgAwsIds = d.security_group_ids.map((id) => sgIdMap.get(id) ?? id);
    return createEcsService(client, clusterName, d, subnetAwsIds, sgAwsIds);
  }
  if (action.action === "delete" && action.live?.aws_id) {
    await client.ecs("DeleteService", {
      cluster: String(action.live.cluster ?? action.live.aws_id),
      service: String(action.live.name ?? action.resource_id),
      force: true,
    });
    return { resource_id: action.resource_id, deleted: true };
  }
  return null;
}
