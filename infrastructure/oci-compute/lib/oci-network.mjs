import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";
import { hdcFreeformTags } from "./oci-config.mjs";
import { iaasHost, containerInstancesHost, ociListItems } from "./oci-api.mjs";
import { igwResourceId, routeTableResourceId, vcnTags, subnetTags, nsgTags } from "./oci-collect.mjs";

/** @typedef {import("./oci-api.mjs").OciClient} OciClient */
/** @typedef {import("./oci-config.mjs").NormalizedOciComputeConfig} NormalizedOciComputeConfig */
/** @typedef {import("./oci-plan.mjs").OciPlanAction} OciPlanAction */
/** @typedef {import("./oci-config.mjs").NormalizedNsgRule} NormalizedNsgRule */

/**
 * @param {NormalizedNsgRule} rule
 * @param {"INGRESS" | "EGRESS"} direction
 */
function nsgRulePayload(rule, direction) {
  const protocol =
    rule.protocol === "all" || rule.protocol === "-1" ? "all" : rule.protocol.toLowerCase();
  /** @type {Record<string, unknown>} */
  const payload = {
    direction,
    protocol: protocol === "tcp" ? "6" : protocol === "udp" ? "17" : protocol === "icmp" ? "1" : "all",
    isStateless: false,
  };
  if (direction === "INGRESS") {
    payload.source = rule.source || "0.0.0.0/0";
    payload.sourceType = "CIDR_BLOCK";
  } else {
    payload.destination = rule.destination || "0.0.0.0/0";
    payload.destinationType = "CIDR_BLOCK";
  }
  if (protocol === "6" || protocol === "17") {
    payload.tcpOptions =
      protocol === "6"
        ? {
            destinationPortRange: {
              min: rule.port_min ?? 1,
              max: rule.port_max ?? rule.port_min ?? 65535,
            },
          }
        : undefined;
    payload.udpOptions =
      protocol === "17"
        ? {
            destinationPortRange: {
              min: rule.port_min ?? 1,
              max: rule.port_max ?? rule.port_min ?? 65535,
            },
          }
        : undefined;
  }
  return payload;
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {OciPlanAction} action
 * @param {Map<string, string>} vcnIdMap
 */
export async function createVcn(client, config, action, vcnIdMap) {
  const host = iaasHost(client.region);
  const vcn = /** @type {import("./oci-config.mjs").NormalizedVcn} */ (action.desired);
  const body = {
    compartmentId: config.compartment_id,
    cidrBlock: vcn.cidr,
    displayName: vcn.id,
    dnsLabel: vcn.dns_label,
    freeformTags: vcnTags(vcn, config),
  };
  const json = await client.request({ host, path: "/20160918/vcns", method: "POST", body });
  const ocid = typeof json.id === "string" ? json.id : "";
  if (!ocid) throw new Error(`CreateVcn failed for ${vcn.id}`);
  vcnIdMap.set(vcn.id, ocid);
  return { resource_id: vcn.id, oci_id: ocid, kind: "vcn" };
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {OciPlanAction} action
 * @param {Map<string, string>} vcnIdMap
 * @param {Map<string, string>} igwIdMap
 */
export async function createInternetGateway(client, config, action, vcnIdMap, igwIdMap) {
  const host = iaasHost(client.region);
  const vcnConfigId = action.parent_vcn_id ?? action.desired?.vcn_id;
  const vcnOcid = vcnConfigId ? vcnIdMap.get(String(vcnConfigId)) : null;
  if (!vcnOcid) throw new Error(`internet gateway ${action.resource_id}: VCN not resolved`);
  const resourceId = String(action.resource_id);
  const body = {
    compartmentId: config.compartment_id,
    vcnId: vcnOcid,
    displayName: resourceId,
    isEnabled: true,
    freeformTags: hdcFreeformTags(config.default_tags, {}, resourceId),
  };
  const json = await client.request({ host, path: "/20160918/internetGateways", method: "POST", body });
  const ocid = typeof json.id === "string" ? json.id : "";
  if (!ocid) throw new Error(`CreateInternetGateway failed for ${resourceId}`);
  igwIdMap.set(resourceId, ocid);
  return { resource_id: resourceId, oci_id: ocid, kind: "internet_gateway" };
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {OciPlanAction} action
 * @param {Map<string, string>} vcnIdMap
 * @param {Map<string, string>} igwIdMap
 * @param {Map<string, string>} rtIdMap
 */
export async function createRouteTable(client, config, action, vcnIdMap, igwIdMap, rtIdMap) {
  const host = iaasHost(client.region);
  const vcnConfigId = action.parent_vcn_id ?? action.desired?.vcn_id;
  const vcnOcid = vcnConfigId ? vcnIdMap.get(String(vcnConfigId)) : null;
  if (!vcnOcid) throw new Error(`route table ${action.resource_id}: VCN not resolved`);
  const igwOcid = vcnConfigId ? igwIdMap.get(igwResourceId(String(vcnConfigId))) : null;
  const resourceId = String(action.resource_id);
  const body = {
    compartmentId: config.compartment_id,
    vcnId: vcnOcid,
    displayName: resourceId,
    routeRules: igwOcid
      ? [
          {
            destinationType: "CIDR_BLOCK",
            destination: "0.0.0.0/0",
            networkEntityId: igwOcid,
          },
        ]
      : [],
    freeformTags: hdcFreeformTags(config.default_tags, {}, resourceId),
  };
  const json = await client.request({ host, path: "/20160918/routeTables", method: "POST", body });
  const ocid = typeof json.id === "string" ? json.id : "";
  if (!ocid) throw new Error(`CreateRouteTable failed for ${resourceId}`);
  rtIdMap.set(resourceId, ocid);
  return { resource_id: resourceId, oci_id: ocid, kind: "route_table" };
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {string} availabilityDomain
 * @param {OciPlanAction} action
 * @param {Map<string, string>} vcnIdMap
 * @param {Map<string, string>} rtIdMap
 * @param {Map<string, string>} subnetIdMap
 */
export async function createSubnet(client, config, availabilityDomain, action, vcnIdMap, rtIdMap, subnetIdMap) {
  const host = iaasHost(client.region);
  const subnet = /** @type {import("./oci-config.mjs").NormalizedSubnet} */ (action.desired);
  const vcnOcid = vcnIdMap.get(subnet.vcn_id);
  if (!vcnOcid) throw new Error(`subnet ${subnet.id}: VCN ${subnet.vcn_id} not resolved`);
  const rtOcid = subnet.public ? rtIdMap.get(routeTableResourceId(subnet.vcn_id)) : undefined;
  const body = {
    compartmentId: config.compartment_id,
    vcnId: vcnOcid,
    cidrBlock: subnet.cidr,
    displayName: subnet.id,
    dnsLabel: subnet.dns_label,
    availabilityDomain,
    prohibitPublicIpOnVnic: !subnet.public,
    routeTableId: rtOcid,
    freeformTags: subnetTags(subnet, config),
  };
  const json = await client.request({ host, path: "/20160918/subnets", method: "POST", body });
  const ocid = typeof json.id === "string" ? json.id : "";
  if (!ocid) throw new Error(`CreateSubnet failed for ${subnet.id}`);
  subnetIdMap.set(subnet.id, ocid);
  return { resource_id: subnet.id, oci_id: ocid, kind: "subnet" };
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {OciPlanAction} action
 * @param {Map<string, string>} vcnIdMap
 * @param {Map<string, string>} nsgIdMap
 */
export async function createNsg(client, config, action, vcnIdMap, nsgIdMap) {
  const host = iaasHost(client.region);
  const nsg = /** @type {import("./oci-config.mjs").NormalizedNsg} */ (action.desired);
  const vcnOcid = vcnIdMap.get(nsg.vcn_id);
  if (!vcnOcid) throw new Error(`nsg ${nsg.id}: VCN not resolved`);
  const body = {
    compartmentId: config.compartment_id,
    vcnId: vcnOcid,
    displayName: nsg.id,
    freeformTags: nsgTags(nsg, config),
  };
  const json = await client.request({ host, path: "/20160918/networkSecurityGroups", method: "POST", body });
  const ocid = typeof json.id === "string" ? json.id : "";
  if (!ocid) throw new Error(`CreateNetworkSecurityGroup failed for ${nsg.id}`);
  nsgIdMap.set(nsg.id, ocid);

  const rules = [
    ...nsg.ingress.map((r) => nsgRulePayload(r, "INGRESS")),
    ...nsg.egress.map((r) => nsgRulePayload(r, "EGRESS")),
  ];
  if (rules.length) {
    await client.request({
      host,
      path: `/20160918/networkSecurityGroups/${encodeURIComponent(ocid)}/actions/addSecurityRules`,
      method: "POST",
      body: { securityRules: rules },
    });
  }
  return { resource_id: nsg.id, oci_id: ocid, kind: "nsg" };
}

/**
 * @param {import("./oci-config.mjs").NormalizedNsgRule} rule
 * @param {"INGRESS" | "EGRESS"} direction
 */
function nsgRuleKey(rule, direction) {
  const protocol =
    rule.protocol === "all" || rule.protocol === "-1" ? "all" : rule.protocol.toLowerCase();
  const proto =
    protocol === "tcp" ? "6" : protocol === "udp" ? "17" : protocol === "icmp" ? "1" : "all";
  const endpoint =
    direction === "INGRESS"
      ? String(rule.source || "0.0.0.0/0")
      : String(rule.destination || "0.0.0.0/0");
  const portMin = rule.port_min ?? 1;
  const portMax = rule.port_max ?? rule.port_min ?? 65535;
  return `${direction}|${proto}|${endpoint}|${portMin}|${portMax}`;
}

/**
 * @param {Record<string, unknown>} liveRule
 */
function liveNsgRuleKey(liveRule) {
  const direction = String(liveRule.direction ?? "");
  const protocol = String(liveRule.protocol ?? "all");
  const endpoint =
    direction === "INGRESS"
      ? String(
          /** @type {{ source?: string }} */ (liveRule).source ??
            /** @type {{ cidrBlock?: string }} */ (liveRule).cidrBlock ??
            "",
        )
      : String(
          /** @type {{ destination?: string }} */ (liveRule).destination ??
            /** @type {{ cidrBlock?: string }} */ (liveRule).cidrBlock ??
            "",
        );
  const tcp = /** @type {{ destinationPortRange?: { min?: number; max?: number } }} */ (liveRule)
    .tcpOptions?.destinationPortRange;
  const udp = /** @type {{ destinationPortRange?: { min?: number; max?: number } }} */ (liveRule)
    .udpOptions?.destinationPortRange;
  const range = tcp ?? udp;
  const portMin = range?.min ?? 1;
  const portMax = range?.max ?? portMin;
  return `${direction}|${protocol}|${endpoint}|${portMin}|${portMax}`;
}

/**
 * @param {OciClient} client
 * @param {string} nsgOcid
 */
async function listNsgSecurityRules(client, nsgOcid) {
  const host = iaasHost(client.region);
  const json = await client.request({
    host,
    path: `/20160918/networkSecurityGroups/${encodeURIComponent(nsgOcid)}/securityRules`,
  });
  return ociListItems(json);
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {OciPlanAction} action
 * @param {string} nsgOcid
 */
export async function syncNsgRules(client, config, action, nsgOcid) {
  const host = iaasHost(client.region);
  const nsg = /** @type {import("./oci-config.mjs").NormalizedNsg} */ (action.desired);
  const desiredRules = [
    ...nsg.ingress.map((r) => ({ rule: r, direction: /** @type {const} */ ("INGRESS") })),
    ...nsg.egress.map((r) => ({ rule: r, direction: /** @type {const} */ ("EGRESS") })),
  ];
  const liveRules = await listNsgSecurityRules(client, nsgOcid);
  const liveKeys = new Set(
    liveRules
      .filter((row) => typeof row === "object" && row)
      .map((row) => liveNsgRuleKey(/** @type {Record<string, unknown>} */ (row))),
  );
  const missing = desiredRules
    .filter(({ rule, direction }) => !liveKeys.has(nsgRuleKey(rule, direction)))
    .map(({ rule, direction }) => nsgRulePayload(rule, direction));
  if (missing.length) {
    await client.request({
      host,
      path: `/20160918/networkSecurityGroups/${encodeURIComponent(nsgOcid)}/actions/addSecurityRules`,
      method: "POST",
      body: { securityRules: missing },
    });
  }
  return {
    resource_id: nsg.id,
    oci_id: nsgOcid,
    kind: "nsg",
    rules_added: missing.length,
  };
}

/**
 * @param {NormalizedOciComputeConfig} config
 * @param {string} vcnId
 * @returns {{ port: number; source: string }[]}
 */
export function collectTcpIngressRulesForSecurityListSync(config, vcnId) {
  /** @type {Map<string, { port: number; source: string }>} */
  const rules = new Map();
  for (const nsg of config.network_security_groups) {
    if (!nsg.managed || nsg.vcn_id !== vcnId) continue;
    for (const rule of nsg.ingress) {
      if (rule.protocol !== "tcp") continue;
      const min = rule.port_min ?? 1;
      const max = rule.port_max ?? min;
      const source = rule.source || "0.0.0.0/0";
      for (let port = min; port <= max; port += 1) {
        rules.set(`${port}|${source}`, { port, source });
      }
    }
  }
  return [...rules.values()].sort((a, b) => a.port - b.port || a.source.localeCompare(b.source));
}

/**
 * @param {number} port
 * @param {string} [source]
 */
export function buildSecurityListTcpIngressRule(port, source = "0.0.0.0/0") {
  return {
    isStateless: false,
    protocol: "6",
    source,
    sourceType: "CIDR_BLOCK",
    tcpOptions: { destinationPortRange: { min: port, max: port } },
    description: `hdc tcp/${port}`,
  };
}

/**
 * @param {Record<string, unknown>} rule
 * @returns {string | null}
 */
export function securityListTcpRuleKey(rule) {
  if (String(rule.protocol ?? "") !== "6") return null;
  const source = String(rule.source ?? "");
  const range = /** @type {{ destinationPortRange?: { min?: number; max?: number } }} */ (
    rule.tcpOptions
  )?.destinationPortRange;
  const min = range?.min;
  const max = range?.max ?? min;
  if (min == null || max == null) return null;
  return `6|${source}|${min}|${max}`;
}

/**
 * @param {number} port
 * @param {string} [source]
 */
function securityListTcpIngressRule(port, source = "0.0.0.0/0") {
  return buildSecurityListTcpIngressRule(port, source);
}

/**
 * @param {Record<string, unknown>} rule
 * @returns {string | null}
 */
function liveSecurityListTcpRuleKey(rule) {
  return securityListTcpRuleKey(rule);
}

/**
 * OCI evaluates security lists and NSGs together — both must allow ingress.
 * Mirror managed NSG TCP ingress ports onto each public subnet's security lists.
 *
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {Awaited<ReturnType<import("./oci-collect.mjs").collectOciLiveState>>} live
 * @param {{ match?: (resourceId: string) => boolean }} [opts]
 */
export async function syncPublicSubnetSecurityLists(client, config, live, opts = {}) {
  const match = opts.match ?? (() => true);
  const host = iaasHost(client.region);
  const liveSubnets = live.byResourceId("subnets");
  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const subnet of config.subnets) {
    if (!subnet.managed || !subnet.public || !match(subnet.id)) continue;
    const liveSubnet = liveSubnets.get(subnet.id);
    const subnetOcid = typeof liveSubnet?.id === "string" ? liveSubnet.id : "";
    if (!subnetOcid) continue;

    const ingressRules = collectTcpIngressRulesForSecurityListSync(config, subnet.vcn_id);
    if (!ingressRules.length) continue;

    const subnetDetail = await client.request({
      host,
      path: `/20160918/subnets/${encodeURIComponent(subnetOcid)}`,
    });
    const slIds = Array.isArray(subnetDetail.securityListIds) ? subnetDetail.securityListIds : [];

    for (const slOcid of slIds) {
      if (typeof slOcid !== "string" || !slOcid) continue;
      const sl = await client.request({
        host,
        path: `/20160918/securityLists/${encodeURIComponent(slOcid)}`,
      });
      const ingress = Array.isArray(sl.ingressSecurityRules) ? [...sl.ingressSecurityRules] : [];
      const existingKeys = new Set(
        ingress
          .map((row) =>
            liveSecurityListTcpRuleKey(/** @type {Record<string, unknown>} */ (row)),
          )
          .filter((key) => typeof key === "string"),
      );
      /** @type {{ port: number; source: string }[]} */
      const added = [];
      for (const { port, source } of ingressRules) {
        const key = `6|${source}|${port}|${port}`;
        if (existingKeys.has(key)) continue;
        ingress.push(securityListTcpIngressRule(port, source));
        added.push({ port, source });
      }
      if (!added.length) continue;
      await client.request({
        host,
        path: `/20160918/securityLists/${encodeURIComponent(slOcid)}`,
        method: "PUT",
        headers: { "if-match": String(sl.etag ?? "") },
        body: {
          ingressSecurityRules: ingress,
          egressSecurityRules: Array.isArray(sl.egressSecurityRules) ? sl.egressSecurityRules : [],
        },
      });
      results.push({
        resource_id: subnet.id,
        kind: "security_list",
        oci_id: slOcid,
        action: "update",
        ports_added: added,
      });
    }
  }

  return results;
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {string} availabilityDomain
 * @param {OciPlanAction} action
 * @param {Map<string, string>} subnetIdMap
 * @param {Map<string, string>} nsgIdMap
 */
export async function launchInstance(client, config, availabilityDomain, action, subnetIdMap, nsgIdMap) {
  const host = iaasHost(client.region);
  const inst = /** @type {import("./oci-config.mjs").NormalizedOciInstance} */ (action.desired);
  const subnetOcid = subnetIdMap.get(inst.subnet_id);
  if (!subnetOcid) throw new Error(`instance ${inst.id}: subnet not resolved`);
  const nsgOcids = inst.nsg_ids.map((id) => {
    const ocid = nsgIdMap.get(id);
    if (!ocid) throw new Error(`instance ${inst.id}: NSG ${id} not resolved`);
    return ocid;
  });
  const { publicKeyLines } = discoverLocalSshMaterial();
  const sshKeys = publicKeyLines.join("\n");
  const body = {
    availabilityDomain,
    compartmentId: config.compartment_id,
    displayName: inst.system_id,
    shape: inst.shape,
    ...(inst.shape.includes("Flex")
      ? { shapeConfig: { ocpus: inst.ocpus, memoryInGBs: inst.memory_gb } }
      : {}),
    freeformTags: hdcFreeformTags(config.default_tags, inst.tags, inst.id),
    sourceDetails: {
      sourceType: "image",
      imageId: inst.image_ocid,
      bootVolumeSizeInGBs: inst.boot_volume_gb,
    },
    createVnicDetails: {
      subnetId: subnetOcid,
      assignPublicIp: inst.assign_public_ip,
      nsgIds: nsgOcids,
      displayName: `${inst.system_id}-vnic`,
    },
    metadata: sshKeys ? { ssh_authorized_keys: sshKeys } : {},
  };
  const json = await client.request({ host, path: "/20160918/instances", method: "POST", body });
  const ocid = typeof json.id === "string" ? json.id : "";
  if (!ocid) throw new Error(`LaunchInstance failed for ${inst.id}`);
  return {
    resource_id: inst.id,
    system_id: inst.system_id,
    oci_id: ocid,
    kind: "instance",
  };
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {string} availabilityDomain
 * @param {OciPlanAction} action
 * @param {Map<string, string>} subnetIdMap
 * @param {Map<string, string>} nsgIdMap
 */
export async function createContainerInstance(
  client,
  config,
  availabilityDomain,
  action,
  subnetIdMap,
  nsgIdMap,
) {
  const host = containerInstancesHost(client.region);
  const ci = /** @type {import("./oci-config.mjs").NormalizedContainerInstance} */ (action.desired);
  const subnetOcid = subnetIdMap.get(ci.subnet_id);
  if (!subnetOcid) throw new Error(`container instance ${ci.id}: subnet not resolved`);
  const nsgOcids = ci.nsg_ids.map((id) => {
    const ocid = nsgIdMap.get(id);
    if (!ocid) throw new Error(`container instance ${ci.id}: NSG ${id} not resolved`);
    return ocid;
  });
  const body = {
    availabilityDomain,
    compartmentId: config.compartment_id,
    displayName: ci.system_id,
    shape: ci.shape,
    shapeConfig: { ocpus: ci.ocpus, memoryInGBs: ci.memory_gb },
    freeformTags: hdcFreeformTags(config.default_tags, ci.tags, ci.id),
    containers: ci.containers.map((c) => ({
      displayName: c.name,
      imageUrl: c.image,
      isResourcePrincipalDisabled: true,
    })),
    vnics: [
      {
        subnetId: subnetOcid,
        isPublicIpAssigned: ci.assign_public_ip,
        nsgIds: nsgOcids,
      },
    ],
  };
  const json = await client.request({
    host,
    path: "/20190918/containerInstances",
    method: "POST",
    body,
  });
  const ocid = typeof json.id === "string" ? json.id : "";
  if (!ocid) throw new Error(`CreateContainerInstance failed for ${ci.id}`);
  return {
    resource_id: ci.id,
    system_id: ci.system_id,
    oci_id: ocid,
    kind: "container_instance",
  };
}

/**
 * @param {OciClient} client
 * @param {OciPlanAction} action
 */
export async function deleteOciResource(client, action) {
  const live = action.live ?? {};
  const ocid = typeof live.id === "string" ? live.id : "";
  if (!ocid) throw new Error(`delete ${action.kind} ${action.resource_id}: missing live id`);

  if (action.kind === "container_instance") {
    await client.request({
      host: containerInstancesHost(client.region),
      path: `/20190918/containerInstances/${encodeURIComponent(ocid)}`,
      method: "DELETE",
    });
    return { resource_id: action.resource_id, kind: action.kind, deleted: true };
  }

  const host = iaasHost(client.region);
  const paths = {
    vcn: `/20160918/vcns/${encodeURIComponent(ocid)}`,
    internet_gateway: `/20160918/internetGateways/${encodeURIComponent(ocid)}`,
    route_table: `/20160918/routeTables/${encodeURIComponent(ocid)}`,
    subnet: `/20160918/subnets/${encodeURIComponent(ocid)}`,
    nsg: `/20160918/networkSecurityGroups/${encodeURIComponent(ocid)}`,
    instance: `/20160918/instances/${encodeURIComponent(ocid)}`,
  };
  const path = paths[/** @type {keyof typeof paths} */ (action.kind)];
  if (!path) throw new Error(`unsupported delete kind ${action.kind}`);
  if (action.kind === "instance") {
    await client.request({
      host,
      path,
      method: "POST",
      query: { action: "TERMINATE" },
    });
  } else {
    await client.request({ host, path, method: "DELETE" });
  }
  return { resource_id: action.resource_id, kind: action.kind, deleted: true };
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 * @param {Awaited<ReturnType<import("./oci-collect.mjs").collectOciLiveState>>} live
 * @param {Map<string, string>} vcnIdMap
 * @param {Map<string, string>} igwIdMap
 * @param {Map<string, string>} rtIdMap
 * @param {Map<string, string>} subnetIdMap
 * @param {Map<string, string>} nsgIdMap
 */
export function seedIdMapsFromLive(live, vcnIdMap, igwIdMap, rtIdMap, subnetIdMap, nsgIdMap) {
  for (const item of live.vcns) {
    const id = /** @type {{ hdc_resource_id?: string; id?: string }} */ (item).hdc_resource_id;
    const ocid = /** @type {{ id?: string }} */ (item).id;
    if (id && ocid) vcnIdMap.set(id, ocid);
  }
  for (const item of live.internet_gateways) {
    const id = /** @type {{ hdc_resource_id?: string; id?: string }} */ (item).hdc_resource_id;
    const ocid = /** @type {{ id?: string }} */ (item).id;
    if (id && ocid) igwIdMap.set(id, ocid);
  }
  for (const item of live.route_tables) {
    const id = /** @type {{ hdc_resource_id?: string; id?: string }} */ (item).hdc_resource_id;
    const ocid = /** @type {{ id?: string }} */ (item).id;
    if (id && ocid) rtIdMap.set(id, ocid);
  }
  for (const item of live.subnets) {
    const id = /** @type {{ hdc_resource_id?: string; id?: string }} */ (item).hdc_resource_id;
    const ocid = /** @type {{ id?: string }} */ (item).id;
    if (id && ocid) subnetIdMap.set(id, ocid);
  }
  for (const item of live.network_security_groups) {
    const id = /** @type {{ hdc_resource_id?: string; id?: string }} */ (item).hdc_resource_id;
    const ocid = /** @type {{ id?: string }} */ (item).id;
    if (id && ocid) nsgIdMap.set(id, ocid);
  }
}
