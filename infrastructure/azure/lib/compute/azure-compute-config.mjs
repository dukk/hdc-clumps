const VALID_MODES = new Set(["azure-vm", "azure-aci"]);

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} raw
 */
export function normalizeAzureComputeConfig(raw) {
  if (!isObject(raw)) throw new Error("azure-compute config must be an object");

  const defaultsAzure = isObject(raw.defaults) && isObject(raw.defaults.azure) ? raw.defaults.azure : {};
  const deploymentsRaw = Array.isArray(raw.deployments) ? raw.deployments : [];

  /** @type {import("./azure-compute-deployments.mjs").NormalizedDeployment[]} */
  const deployments = [];

  for (const row of deploymentsRaw) {
    if (!isObject(row)) continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) throw new Error("deployments[].id is required");

    const mode = typeof row.mode === "string" ? row.mode.trim() : "";
    if (!VALID_MODES.has(mode)) {
      throw new Error(`deployments[${id}].mode must be azure-vm or azure-aci`);
    }

    const systemId = typeof row.system_id === "string" ? row.system_id.trim() : "";
    if (!systemId) throw new Error(`deployments[${id}].system_id is required`);

    const azureRow = isObject(row.azure) ? row.azure : {};
    const mergedAzure = { ...defaultsAzure, ...azureRow };

    const subscriptionId = String(mergedAzure.subscription_id ?? "").trim();
    const resourceGroup = String(mergedAzure.resource_group ?? "").trim();
    const location = String(mergedAzure.location ?? "").trim();
    if (!subscriptionId) throw new Error(`deployments[${id}]: subscription_id required (defaults.azure or azure)`);
    if (!resourceGroup) throw new Error(`deployments[${id}]: resource_group required`);
    if (!location) throw new Error(`deployments[${id}]: location required`);

    const tags = isObject(mergedAzure.tags) ? { ...mergedAzure.tags } : {};

    deployments.push({
      id,
      systemId,
      mode,
      azure: {
        subscription_id: subscriptionId,
        resource_group: resourceGroup,
        location,
        tags,
        vm_size: typeof mergedAzure.vm_size === "string" ? mergedAzure.vm_size.trim() : "",
        os_disk_gb:
          typeof mergedAzure.os_disk_gb === "number" ? mergedAzure.os_disk_gb : Number(mergedAzure.os_disk_gb) || 64,
        admin_username:
          typeof mergedAzure.admin_username === "string" ? mergedAzure.admin_username.trim() : "hdc",
        image: isObject(mergedAzure.image) ? mergedAzure.image : {},
        cpu: typeof mergedAzure.cpu === "number" ? mergedAzure.cpu : Number(mergedAzure.cpu) || 1,
        memory_gb:
          typeof mergedAzure.memory_gb === "number" ? mergedAzure.memory_gb : Number(mergedAzure.memory_gb) || 1,
        containers: Array.isArray(mergedAzure.containers) ? mergedAzure.containers : [],
        vnet_name: typeof mergedAzure.vnet_name === "string" ? mergedAzure.vnet_name.trim() : "hdc-vnet",
        subnet_name: typeof mergedAzure.subnet_name === "string" ? mergedAzure.subnet_name.trim() : "default",
        public_ip: mergedAzure.public_ip !== false,
        resource_name:
          typeof mergedAzure.resource_name === "string" && mergedAzure.resource_name.trim()
            ? mergedAzure.resource_name.trim()
            : systemId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 64),
      },
    });
  }

  return {
    schema_version: typeof raw.schema_version === "number" ? raw.schema_version : 1,
    defaultsAzure,
    deployments,
    deploymentsById: new Map(deployments.map((d) => [d.id, d])),
    deploymentsBySystemId: new Map(deployments.map((d) => [d.systemId, d])),
  };
}

/**
 * @param {ReturnType<typeof normalizeAzureComputeConfig>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveAzureComputeDeployments(cfg, flags) {
  const instance = flags.instance?.trim();
  const systemId = flags["system-id"]?.trim() || flags.system_id?.trim();

  let list = cfg.deployments;
  if (instance) {
    list = list.filter((d) => d.id === instance);
    if (!list.length) throw new Error(`No deployment with id ${instance}`);
  }
  if (systemId) {
    list = list.filter((d) => d.systemId === systemId);
    if (!list.length) throw new Error(`No deployment with system_id ${systemId}`);
  }
  return list;
}
