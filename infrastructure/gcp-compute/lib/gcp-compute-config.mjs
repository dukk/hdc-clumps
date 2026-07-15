const VALID_MODES = new Set(["gcp-vm", "gcp-cloud-run"]);

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} raw
 */
export function normalizeGcpComputeConfig(raw) {
  if (!isObject(raw)) throw new Error("gcp-compute config must be an object");

  const defaultsGcp = isObject(raw.defaults) && isObject(raw.defaults.gcp) ? raw.defaults.gcp : {};
  const deploymentsRaw = Array.isArray(raw.deployments) ? raw.deployments : [];

  /** @type {NormalizedGcpDeployment[]} */
  const deployments = [];

  for (const row of deploymentsRaw) {
    if (!isObject(row)) continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) throw new Error("deployments[].id is required");

    const mode = typeof row.mode === "string" ? row.mode.trim() : "";
    if (!VALID_MODES.has(mode)) {
      throw new Error(`deployments[${id}].mode must be gcp-vm or gcp-cloud-run`);
    }

    const systemId = typeof row.system_id === "string" ? row.system_id.trim() : "";
    if (!systemId) throw new Error(`deployments[${id}].system_id is required`);

    const gcpRow = isObject(row.gcp) ? row.gcp : {};
    const merged = { ...defaultsGcp, ...gcpRow };

    const projectId = String(merged.project_id ?? "").trim();
    const region = String(merged.region ?? "").trim();
    const zone = String(merged.zone ?? "").trim();
    if (!projectId) throw new Error(`deployments[${id}]: project_id required`);
    if (!region) throw new Error(`deployments[${id}]: region required`);
    if (mode === "gcp-vm" && !zone) throw new Error(`deployments[${id}]: zone required for gcp-vm`);

    const labels = isObject(merged.labels) ? { ...merged.labels } : {};

    deployments.push({
      id,
      systemId,
      mode,
      gcp: {
        project_id: projectId,
        region,
        zone: zone || `${region}-a`,
        labels,
        resource_name:
          typeof merged.resource_name === "string" && merged.resource_name.trim()
            ? merged.resource_name.trim()
            : systemId.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 63),
        machine_type: typeof merged.machine_type === "string" ? merged.machine_type.trim() : "e2-small",
        boot_disk_gb:
          typeof merged.boot_disk_gb === "number" ? merged.boot_disk_gb : Number(merged.boot_disk_gb) || 30,
        image_family: typeof merged.image_family === "string" ? merged.image_family.trim() : "ubuntu-2204-lts",
        image_project: typeof merged.image_project === "string" ? merged.image_project.trim() : "ubuntu-os-cloud",
        cloud_run: isObject(merged.cloud_run) ? merged.cloud_run : {},
        image:
          typeof merged.image === "string"
            ? merged.image.trim()
            : typeof merged.cloud_run === "object" &&
                merged.cloud_run &&
                typeof /** @type {{ image?: string }} */ (merged.cloud_run).image === "string"
              ? String(/** @type {{ image?: string }} */ (merged.cloud_run).image).trim()
              : "gcr.io/cloudrun/hello",
        cpu: typeof merged.cpu === "number" ? merged.cpu : Number(merged.cpu) || 1,
        memory_mb:
          typeof merged.memory_mb === "number" ? merged.memory_mb : Number(merged.memory_mb) || 512,
        min_instances:
          typeof merged.min_instances === "number"
            ? merged.min_instances
            : Number(merged.min_instances) || 0,
        max_instances:
          typeof merged.max_instances === "number"
            ? merged.max_instances
            : Number(merged.max_instances) || 1,
        allow_unauthenticated: merged.allow_unauthenticated !== false,
      },
    });
  }

  return {
    schema_version: typeof raw.schema_version === "number" ? raw.schema_version : 1,
    defaultsGcp,
    deployments,
    deploymentsById: new Map(deployments.map((d) => [d.id, d])),
    deploymentsBySystemId: new Map(deployments.map((d) => [d.systemId, d])),
  };
}

/** @typedef {ReturnType<typeof normalizeGcpComputeConfig>["deployments"][number]} NormalizedGcpDeployment */

/**
 * @param {ReturnType<typeof normalizeGcpComputeConfig>} cfg
 * @param {Record<string, string>} flags
 */
export function resolveGcpComputeDeployments(cfg, flags) {
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
