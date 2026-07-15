/** HDC freeform tag keys applied to created OCI resources. */
export const HDC_MANAGED_TAG_KEY = "hdc-managed";
export const HDC_MANAGED_TAG_VALUE = "true";
export const HDC_RESOURCE_ID_TAG_KEY = "hdc-resource-id";

/**
 * @typedef {object} NormalizedNsgRule
 * @property {string} protocol
 * @property {number | null} port_min
 * @property {number | null} port_max
 * @property {string} source
 * @property {string} destination
 */

/**
 * @typedef {object} NormalizedVcn
 * @property {string} id
 * @property {boolean} managed
 * @property {string} cidr
 * @property {string} dns_label
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedSubnet
 * @property {string} id
 * @property {boolean} managed
 * @property {string} vcn_id
 * @property {string} cidr
 * @property {boolean} public
 * @property {string} dns_label
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedNsg
 * @property {string} id
 * @property {boolean} managed
 * @property {string} vcn_id
 * @property {NormalizedNsgRule[]} ingress
 * @property {NormalizedNsgRule[]} egress
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedOciContainer
 * @property {string} name
 * @property {string} image
 * @property {number[]} ports
 */

/**
 * @typedef {object} NormalizedOciInstance
 * @property {string} id
 * @property {boolean} managed
 * @property {string} system_id
 * @property {string} subnet_id
 * @property {string[]} nsg_ids
 * @property {string} shape
 * @property {number} ocpus
 * @property {number} memory_gb
 * @property {number} boot_volume_gb
 * @property {string} image_ocid
 * @property {boolean} assign_public_ip
 * @property {Record<string, string>} tags
 */

/**
 * @typedef {object} NormalizedContainerInstance
 * @property {string} id
 * @property {boolean} managed
 * @property {string} system_id
 * @property {string} subnet_id
 * @property {string[]} nsg_ids
 * @property {string} shape
 * @property {number} ocpus
 * @property {number} memory_gb
 * @property {boolean} assign_public_ip
 * @property {NormalizedOciContainer[]} containers
 * @property {Record<string, string>} tags
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} row
 * @param {string} label
 */
function parseManagedResource(row, label) {
  if (!isObject(row)) throw new Error(`${label} must be an object`);
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) throw new Error(`${label}.id is required`);
  const managed = row.managed !== false;
  const tags = isObject(row.tags) ? { ...row.tags } : {};
  return { id, managed, tags };
}

/**
 * @param {unknown} row
 * @returns {NormalizedNsgRule}
 */
function parseNsgRule(row, direction) {
  if (!isObject(row)) {
    return {
      protocol: "all",
      port_min: null,
      port_max: null,
      source: direction === "ingress" ? "0.0.0.0/0" : "",
      destination: direction === "egress" ? "0.0.0.0/0" : "",
    };
  }
  const protocol = typeof row.protocol === "string" ? row.protocol.trim().toLowerCase() : "all";
  const portMin =
    typeof row.port_min === "number"
      ? row.port_min
      : typeof row.from_port === "number"
        ? row.from_port
        : null;
  const portMax =
    typeof row.port_max === "number"
      ? row.port_max
      : typeof row.to_port === "number"
        ? row.to_port
        : portMin;
  const source =
    typeof row.source === "string"
      ? row.source.trim()
      : typeof row.cidr === "string"
        ? row.cidr.trim()
        : "0.0.0.0/0";
  const destination =
    typeof row.destination === "string"
      ? row.destination.trim()
      : typeof row.cidr === "string"
        ? row.cidr.trim()
        : "0.0.0.0/0";
  return {
    protocol,
    port_min: portMin,
    port_max: portMax,
    source,
    destination,
  };
}

/**
 * @param {Record<string, string>} defaultTags
 * @param {Record<string, string>} resourceTags
 * @param {string} resourceId
 */
export function hdcFreeformTags(defaultTags, resourceTags, resourceId) {
  return {
    ...defaultTags,
    ...resourceTags,
    [HDC_MANAGED_TAG_KEY]: HDC_MANAGED_TAG_VALUE,
    [HDC_RESOURCE_ID_TAG_KEY]: resourceId,
  };
}

/**
 * @param {unknown} raw
 */
export function normalizeOciComputeConfig(raw) {
  if (!isObject(raw)) throw new Error("oci-compute config must be an object");

  const ociBlock = isObject(raw.oci) ? raw.oci : {};
  const costBlock = isObject(raw.cost) ? raw.cost : {};

  const region = String(ociBlock.region ?? process.env.HDC_OCI_REGION ?? "").trim();
  const compartmentId = String(ociBlock.compartment_id ?? "").trim();
  if (!region) throw new Error("oci.region or HDC_OCI_REGION is required");
  if (!compartmentId) throw new Error("oci.compartment_id is required");

  const availabilityDomain =
    typeof ociBlock.availability_domain === "string" ? ociBlock.availability_domain.trim() : "";
  const defaultTags = isObject(ociBlock.default_tags) ? { ...ociBlock.default_tags } : {};

  /** @type {NormalizedVcn[]} */
  const vcns = [];
  for (const row of Array.isArray(raw.vcns) ? raw.vcns : []) {
    const base = parseManagedResource(row, "vcns[]");
    if (!isObject(row)) continue;
    const cidr = typeof row.cidr === "string" ? row.cidr.trim() : "";
    if (!cidr) throw new Error(`vcns[${base.id}].cidr is required`);
    const dnsLabel =
      typeof row.dns_label === "string" && row.dns_label.trim()
        ? row.dns_label.trim()
        : base.id.replace(/[^a-z0-9]/gi, "").slice(0, 15).toLowerCase() || "hdcvcn";
    vcns.push({
      ...base,
      cidr,
      dns_label: dnsLabel,
    });
  }

  /** @type {NormalizedSubnet[]} */
  const subnets = [];
  for (const row of Array.isArray(raw.subnets) ? raw.subnets : []) {
    const base = parseManagedResource(row, "subnets[]");
    if (!isObject(row)) continue;
    const vcnId = typeof row.vcn_id === "string" ? row.vcn_id.trim() : "";
    const cidr = typeof row.cidr === "string" ? row.cidr.trim() : "";
    if (!vcnId) throw new Error(`subnets[${base.id}].vcn_id is required`);
    if (!cidr) throw new Error(`subnets[${base.id}].cidr is required`);
    const dnsLabel =
      typeof row.dns_label === "string" && row.dns_label.trim()
        ? row.dns_label.trim()
        : base.id.replace(/[^a-z0-9]/gi, "").slice(0, 15).toLowerCase() || "hdcsubnet";
    subnets.push({
      ...base,
      vcn_id: vcnId,
      cidr,
      public: row.public !== false,
      dns_label: dnsLabel,
    });
  }

  /** @type {NormalizedNsg[]} */
  const network_security_groups = [];
  for (const row of Array.isArray(raw.network_security_groups) ? raw.network_security_groups : []) {
    const base = parseManagedResource(row, "network_security_groups[]");
    if (!isObject(row)) continue;
    const vcnId = typeof row.vcn_id === "string" ? row.vcn_id.trim() : "";
    if (!vcnId) throw new Error(`network_security_groups[${base.id}].vcn_id is required`);
    const ingress = Array.isArray(row.ingress) ? row.ingress.map((r) => parseNsgRule(r, "ingress")) : [];
    const egress = Array.isArray(row.egress)
      ? row.egress.map((r) => parseNsgRule(r, "egress"))
      : [{ protocol: "all", port_min: null, port_max: null, source: "", destination: "0.0.0.0/0" }];
    network_security_groups.push({
      ...base,
      vcn_id: vcnId,
      ingress,
      egress,
    });
  }

  /** @type {NormalizedOciInstance[]} */
  const instances = [];
  for (const row of Array.isArray(raw.instances) ? raw.instances : []) {
    const base = parseManagedResource(row, "instances[]");
    if (!isObject(row)) continue;
    const systemId = typeof row.system_id === "string" ? row.system_id.trim() : "";
    const subnetId = typeof row.subnet_id === "string" ? row.subnet_id.trim() : "";
    const imageOcid = typeof row.image_ocid === "string" ? row.image_ocid.trim() : "";
    if (!systemId) throw new Error(`instances[${base.id}].system_id is required`);
    if (!subnetId) throw new Error(`instances[${base.id}].subnet_id is required`);
    if (!imageOcid) throw new Error(`instances[${base.id}].image_ocid is required`);
    const nsgIds = Array.isArray(row.nsg_ids)
      ? row.nsg_ids.map((v) => String(v).trim()).filter(Boolean)
      : [];
    instances.push({
      ...base,
      system_id: systemId,
      subnet_id: subnetId,
      nsg_ids: nsgIds,
      shape: typeof row.shape === "string" ? row.shape.trim() : "VM.Standard.E2.1.Micro",
      ocpus: typeof row.ocpus === "number" ? row.ocpus : Number(row.ocpus) || 1,
      memory_gb: typeof row.memory_gb === "number" ? row.memory_gb : Number(row.memory_gb) || 1,
      boot_volume_gb:
        typeof row.boot_volume_gb === "number" ? row.boot_volume_gb : Number(row.boot_volume_gb) || 50,
      image_ocid: imageOcid,
      assign_public_ip: row.assign_public_ip !== false,
    });
  }

  /** @type {NormalizedContainerInstance[]} */
  const container_instances = [];
  for (const row of Array.isArray(raw.container_instances) ? raw.container_instances : []) {
    const base = parseManagedResource(row, "container_instances[]");
    if (!isObject(row)) continue;
    const systemId = typeof row.system_id === "string" ? row.system_id.trim() : "";
    const subnetId = typeof row.subnet_id === "string" ? row.subnet_id.trim() : "";
    if (!systemId) throw new Error(`container_instances[${base.id}].system_id is required`);
    if (!subnetId) throw new Error(`container_instances[${base.id}].subnet_id is required`);
    const nsgIds = Array.isArray(row.nsg_ids)
      ? row.nsg_ids.map((v) => String(v).trim()).filter(Boolean)
      : [];
    /** @type {NormalizedOciContainer[]} */
    const containers = [];
    for (const c of Array.isArray(row.containers) ? row.containers : []) {
      if (!isObject(c)) continue;
      const name = typeof c.name === "string" ? c.name.trim() : "";
      const image = typeof c.image === "string" ? c.image.trim() : "";
      if (!name || !image) continue;
      containers.push({
        name,
        image,
        ports: Array.isArray(c.ports) ? c.ports.map((p) => Number(p)).filter((p) => p > 0) : [],
      });
    }
    if (!containers.length) {
      throw new Error(`container_instances[${base.id}].containers requires at least one entry`);
    }
    container_instances.push({
      ...base,
      system_id: systemId,
      subnet_id: subnetId,
      nsg_ids: nsgIds,
      shape: typeof row.shape === "string" ? row.shape.trim() : "CI.Standard.E4.Flex",
      ocpus: typeof row.ocpus === "number" ? row.ocpus : Number(row.ocpus) || 1,
      memory_gb: typeof row.memory_gb === "number" ? row.memory_gb : Number(row.memory_gb) || 2,
      assign_public_ip: row.assign_public_ip !== false,
      containers,
    });
  }

  return {
    schema_version: typeof raw.schema_version === "number" ? raw.schema_version : 1,
    region,
    compartment_id: compartmentId,
    availability_domain: availabilityDomain,
    default_tags: defaultTags,
    confirm_before_deploy: costBlock.confirm_before_deploy !== false,
    hours_per_month:
      typeof costBlock.hours_per_month === "number" ? costBlock.hours_per_month : 730,
    vcns,
    subnets,
    network_security_groups,
    instances,
    container_instances,
    vcnsById: new Map(vcns.map((v) => [v.id, v])),
    subnetsById: new Map(subnets.map((s) => [s.id, s])),
    nsgsById: new Map(network_security_groups.map((n) => [n.id, n])),
    instancesById: new Map(instances.map((i) => [i.id, i])),
    containerInstancesById: new Map(container_instances.map((c) => [c.id, c])),
  };
}

/** @typedef {ReturnType<typeof normalizeOciComputeConfig>} NormalizedOciComputeConfig */

/**
 * @param {NormalizedOciComputeConfig} cfg
 * @param {Record<string, string>} flags
 */
export function resolveOciResourceFilter(cfg, flags) {
  const resource = flags.resource?.trim();
  if (!resource) return null;
  const known =
    cfg.vcnsById.has(resource) ||
    cfg.subnetsById.has(resource) ||
    cfg.nsgsById.has(resource) ||
    cfg.instancesById.has(resource) ||
    cfg.containerInstancesById.has(resource);
  if (!known) throw new Error(`No resource with id ${resource}`);
  return resource;
}

/**
 * @param {NormalizedOciComputeConfig} cfg
 * @param {string | null} resourceFilter
 */
export function filterManagedConfig(cfg, resourceFilter) {
  const match = (id) => !resourceFilter || id === resourceFilter;
  const subnetIds = new Set(cfg.subnets.filter((s) => match(s.id)).map((s) => s.id));
  const vcnIds = new Set([
    ...cfg.vcns.filter((v) => match(v.id)).map((v) => v.id),
    ...cfg.subnets.filter((s) => match(s.id)).map((s) => s.vcn_id),
    ...cfg.network_security_groups.filter((n) => match(n.id)).map((n) => n.vcn_id),
  ]);
  const instanceSubnetIds = new Set(cfg.instances.filter((i) => match(i.id)).map((i) => i.subnet_id));
  const containerSubnetIds = new Set(
    cfg.container_instances.filter((c) => match(c.id)).map((c) => c.subnet_id),
  );
  const neededSubnetIds = new Set([...subnetIds, ...instanceSubnetIds, ...containerSubnetIds]);

  return {
    ...cfg,
    vcns: cfg.vcns.filter((v) => v.managed && (match(v.id) || [...neededSubnetIds].some((sid) => cfg.subnetsById.get(sid)?.vcn_id === v.id))),
    subnets: cfg.subnets.filter(
      (s) => s.managed && (match(s.id) || neededSubnetIds.has(s.id) || vcnIds.has(s.vcn_id)),
    ),
    network_security_groups: cfg.network_security_groups.filter(
      (n) => n.managed && (match(n.id) || vcnIds.has(n.vcn_id)),
    ),
    instances: cfg.instances.filter((i) => i.managed && match(i.id)),
    container_instances: cfg.container_instances.filter((c) => c.managed && match(c.id)),
  };
}
