/** @typedef {import("./oci-config.mjs").NormalizedOciComputeConfig} NormalizedOciComputeConfig */

/**
 * @typedef {"vcn" | "internet_gateway" | "route_table" | "subnet" | "nsg" | "instance" | "container_instance"} OciResourceKind
 */

/**
 * @typedef {object} OciPlanAction
 * @property {OciResourceKind} kind
 * @property {string} resource_id
 * @property {"create" | "update" | "delete" | "noop"} action
 * @property {Record<string, unknown> | null} [desired]
 * @property {Record<string, unknown> | null} [live]
 * @property {string[]} [notes]
 * @property {string} [parent_vcn_id]
 */

export const OCI_RESOURCE_ORDER = [
  "vcn",
  "internet_gateway",
  "route_table",
  "subnet",
  "nsg",
  "instance",
  "container_instance",
];

/**
 * @param {OciPlanAction[]} actions
 */
export function sortPlanActions(actions) {
  return [...actions].sort((a, b) => {
    const oa = OCI_RESOURCE_ORDER.indexOf(a.kind);
    const ob = OCI_RESOURCE_ORDER.indexOf(b.kind);
    if (oa !== ob) return oa - ob;
    if (a.action === "delete" && b.action !== "delete") return 1;
    if (b.action === "delete" && a.action !== "delete") return -1;
    return a.resource_id.localeCompare(b.resource_id);
  });
}

/**
 * @param {OciPlanAction[]} actions
 */
export function planHasCreates(actions) {
  return actions.some((a) => a.action === "create");
}

/**
 * @param {NormalizedOciComputeConfig} config
 */
export function vcnsNeedingIgw(config) {
  const publicVcns = new Set(
    config.subnets.filter((s) => s.managed && s.public).map((s) => s.vcn_id),
  );
  return [...publicVcns];
}

/**
 * @param {object} opts
 * @param {NormalizedOciComputeConfig} opts.config
 * @param {Awaited<ReturnType<import("./oci-collect.mjs").collectOciLiveState>>} opts.live
 * @param {boolean} [opts.prune]
 * @param {string | null} [opts.resourceFilter]
 * @returns {OciPlanAction[]}
 */
/**
 * @param {NormalizedOciComputeConfig} config
 * @param {string | null} resourceFilter
 */
export function expandedResourceFilter(config, resourceFilter) {
  if (!resourceFilter) return null;
  /** @type {Set<string>} */
  const ids = new Set([resourceFilter]);

  const instance = config.instancesById.get(resourceFilter);
  if (instance) {
    ids.add(instance.subnet_id);
    for (const nsgId of instance.nsg_ids) ids.add(nsgId);
    const subnet = config.subnetsById.get(instance.subnet_id);
    if (subnet) {
      ids.add(subnet.vcn_id);
      ids.add(`${subnet.vcn_id}-igw`);
      ids.add(`${subnet.vcn_id}-rt`);
    }
  }

  const container = config.containerInstancesById.get(resourceFilter);
  if (container) {
    ids.add(container.subnet_id);
    for (const nsgId of container.nsg_ids) ids.add(nsgId);
    const subnet = config.subnetsById.get(container.subnet_id);
    if (subnet) {
      ids.add(subnet.vcn_id);
      ids.add(`${subnet.vcn_id}-igw`);
      ids.add(`${subnet.vcn_id}-rt`);
    }
  }

  const subnet = config.subnetsById.get(resourceFilter);
  if (subnet) {
    ids.add(subnet.vcn_id);
    ids.add(`${subnet.vcn_id}-igw`);
    ids.add(`${subnet.vcn_id}-rt`);
  }

  const nsg = config.nsgsById.get(resourceFilter);
  if (nsg) {
    ids.add(nsg.vcn_id);
    for (const subnet of config.subnets) {
      if (subnet.managed && subnet.public && subnet.vcn_id === nsg.vcn_id) {
        ids.add(subnet.id);
      }
    }
  }

  if (resourceFilter.endsWith("-igw") || resourceFilter.endsWith("-rt")) {
    const vcnId = resourceFilter.replace(/-(igw|rt)$/, "");
    ids.add(vcnId);
  }

  return ids;
}

export function planOciSync(opts) {
  const { config, live, prune = false, resourceFilter = null } = opts;
  const allowed = expandedResourceFilter(config, resourceFilter);
  const match = (id) => !allowed || allowed.has(id);

  const liveVcns = live.byResourceId("vcns");
  const liveSubnets = live.byResourceId("subnets");
  const liveNsgs = live.byResourceId("network_security_groups");
  const liveIgws = live.byResourceId("internet_gateways");
  const liveRts = live.byResourceId("route_tables");
  const liveInstances = live.byResourceId("instances");
  const liveContainers = live.byResourceId("container_instances");

  /** @type {OciPlanAction[]} */
  const actions = [];

  for (const vcn of config.vcns) {
    if (!vcn.managed || !match(vcn.id)) continue;
    const liveRow = liveVcns.get(vcn.id);
    actions.push({
      kind: "vcn",
      resource_id: vcn.id,
      action: liveRow ? "noop" : "create",
      desired: { ...vcn },
      live: liveRow ? { ...liveRow } : null,
    });
  }

  for (const vcnId of vcnsNeedingIgw(config)) {
    const igwId = `${vcnId}-igw`;
    const rtId = `${vcnId}-rt`;
    if (!match(vcnId) && !match(igwId) && !match(rtId)) continue;
    const liveRow = liveIgws.get(igwId);
    actions.push({
      kind: "internet_gateway",
      resource_id: igwId,
      parent_vcn_id: vcnId,
      action: liveRow ? "noop" : "create",
      desired: { vcn_id: vcnId },
      live: liveRow ? { ...liveRow } : null,
    });
    const liveRt = liveRts.get(rtId);
    actions.push({
      kind: "route_table",
      resource_id: rtId,
      parent_vcn_id: vcnId,
      action: liveRt ? "noop" : "create",
      desired: { vcn_id: vcnId },
      live: liveRt ? { ...liveRt } : null,
    });
  }

  for (const subnet of config.subnets) {
    if (!subnet.managed || !match(subnet.id)) continue;
    const liveRow = liveSubnets.get(subnet.id);
    actions.push({
      kind: "subnet",
      resource_id: subnet.id,
      action: liveRow ? "noop" : "create",
      desired: { ...subnet },
      live: liveRow ? { ...liveRow } : null,
    });
  }

  for (const nsg of config.network_security_groups) {
    if (!nsg.managed || !match(nsg.id)) continue;
    const liveRow = liveNsgs.get(nsg.id);
    actions.push({
      kind: "nsg",
      resource_id: nsg.id,
      action: liveRow ? "update" : "create",
      desired: { ...nsg },
      live: liveRow ? { ...liveRow } : null,
    });
  }

  for (const instance of config.instances) {
    if (!instance.managed || !match(instance.id)) continue;
    const liveRow = liveInstances.get(instance.id);
    actions.push({
      kind: "instance",
      resource_id: instance.id,
      action: liveRow ? "noop" : "create",
      desired: { ...instance },
      live: liveRow ? { ...liveRow } : null,
    });
  }

  for (const ci of config.container_instances ?? []) {
    if (!ci.managed || !match(ci.id)) continue;
    const liveRow = liveContainers.get(ci.id);
    actions.push({
      kind: "container_instance",
      resource_id: ci.id,
      action: liveRow ? "noop" : "create",
      desired: { ...ci },
      live: liveRow ? { ...liveRow } : null,
    });
  }

  if (prune) {
    const desiredIds = new Set(actions.map((a) => a.resource_id));
    for (const [id] of liveVcns) {
      if (!desiredIds.has(id)) {
        actions.push({ kind: "vcn", resource_id: id, action: "delete", desired: null, live: liveVcns.get(id) ?? null });
      }
    }
    for (const [id] of liveSubnets) {
      if (!desiredIds.has(id)) {
        actions.push({
          kind: "subnet",
          resource_id: id,
          action: "delete",
          desired: null,
          live: liveSubnets.get(id) ?? null,
        });
      }
    }
    for (const [id] of liveNsgs) {
      if (!desiredIds.has(id)) {
        actions.push({ kind: "nsg", resource_id: id, action: "delete", desired: null, live: liveNsgs.get(id) ?? null });
      }
    }
    for (const [id] of liveInstances) {
      if (!desiredIds.has(id)) {
        actions.push({
          kind: "instance",
          resource_id: id,
          action: "delete",
          desired: null,
          live: liveInstances.get(id) ?? null,
        });
      }
    }
    for (const [id] of liveContainers) {
      if (!desiredIds.has(id)) {
        actions.push({
          kind: "container_instance",
          resource_id: id,
          action: "delete",
          desired: null,
          live: liveContainers.get(id) ?? null,
        });
      }
    }
  }

  return sortPlanActions(actions);
}

/**
 * @param {OciPlanAction[]} actions
 */
export function planDeleteOnly(actions) {
  return sortPlanActions(actions.filter((a) => a.action === "delete"));
}
