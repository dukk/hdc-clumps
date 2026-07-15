import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken
 * @param {string} opts.projectId
 */
export function createGcpComputeClient(opts) {
  const { getToken, projectId } = opts;

  /**
   * @param {string} url
   * @param {string} [method]
   * @param {unknown} [body]
   */
  async function gcpRequest(url, method = "GET", body) {
    const token = await getToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    /** @type {Record<string, unknown>} */
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (!res.ok) throw new Error(`GCP ${method} failed (${res.status})`);
        return { raw: text };
      }
    }
    if (!res.ok) {
      const err = json.error;
      const detail =
        err && typeof err === "object" && "message" in err
          ? String(/** @type {{ message?: string }} */ (err).message)
          : `HTTP ${res.status}`;
      throw new Error(`GCP ${method} ${url}: ${detail}`);
    }
    return json;
  }

  return {
    gcpRequest,
    projectId,

    /**
     * @param {import("./gcp-compute-config.mjs").NormalizedGcpDeployment} deployment
     */
    async deployVm(deployment) {
      const { gcp } = deployment;
      const name = gcp.resource_name;
      const zone = gcp.zone;
      const { publicKeyLines } = discoverLocalSshMaterial();
      const sshKeys = [...publicKeyLines].map((k) => `hdc:${k}`).join("\n");

      const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances`;
      const body = {
        name,
        machineType: `zones/${zone}/machineTypes/${gcp.machine_type}`,
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: `projects/${gcp.image_project}/global/images/family/${gcp.image_family}`,
              diskSizeGb: String(gcp.boot_disk_gb),
            },
          },
        ],
        networkInterfaces: [{ network: "global/networks/default", accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
        metadata: {
          items: [
            { key: "ssh-keys", value: sshKeys },
            { key: "hdc-system-id", value: deployment.systemId },
          ],
        },
        labels: { ...gcp.labels, "hdc-mode": "gcp-vm" },
        tags: { items: ["hdc-managed"] },
      };

      const op = await gcpRequest(url, "POST", body);
      return {
        resource_name: name,
        zone,
        region: gcp.region,
        mode: "gcp-vm",
        operation: op.name,
        selfLink: op.targetLink ?? op.selfLink,
      };
    },

    /**
     * @param {import("./gcp-compute-config.mjs").NormalizedGcpDeployment} deployment
     */
    async deployCloudRun(deployment) {
      const { gcp } = deployment;
      const name = gcp.resource_name;
      const location = gcp.region;
      const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${location}/services?serviceId=${encodeURIComponent(name)}`;

      const body = {
        labels: { ...gcp.labels, "hdc-mode": "gcp-cloud-run", "hdc-system-id": deployment.systemId },
        template: {
          containers: [
            {
              image: gcp.image,
              resources: {
                limits: {
                  cpu: String(gcp.cpu),
                  memory: `${gcp.memory_mb}Mi`,
                },
              },
            },
          ],
          scaling: {
            minInstanceCount: gcp.min_instances,
            maxInstanceCount: gcp.max_instances,
          },
        },
        ingress: gcp.allow_unauthenticated ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY",
      };

      const svc = await gcpRequest(url, "POST", body);
      return {
        resource_name: name,
        region: location,
        mode: "gcp-cloud-run",
        uri: svc.uri,
        service_id: svc.name,
      };
    },

    /**
     * @param {import("./gcp-compute-config.mjs").NormalizedGcpDeployment} deployment
     */
    async getLiveDeployment(deployment) {
      const { gcp, mode } = deployment;
      const name = gcp.resource_name;
      if (mode === "gcp-vm") {
        const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${gcp.zone}/instances/${name}`;
        try {
          const inst = await gcpRequest(url);
          const status = typeof inst.status === "string" ? inst.status : "UNKNOWN";
          return { exists: true, mode, name, status, selfLink: inst.selfLink };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("404") || msg.includes("notFound")) return null;
          throw e;
        }
      }
      const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${gcp.region}/services/${name}`;
      try {
        const svc = await gcpRequest(url);
        return {
          exists: true,
          mode,
          name,
          uri: svc.uri,
          reconciling: svc.reconciling,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("404") || msg.includes("notFound")) return null;
        throw e;
      }
    },

    /**
     * @param {import("./gcp-compute-config.mjs").NormalizedGcpDeployment} deployment
     */
    async deleteDeployment(deployment) {
      const { gcp, mode } = deployment;
      const name = gcp.resource_name;
      if (mode === "gcp-vm") {
        const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${gcp.zone}/instances/${name}`;
        await gcpRequest(url, "DELETE");
        return { deleted: true, mode, name };
      }
      const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${gcp.region}/services/${name}`;
      await gcpRequest(url, "DELETE");
      return { deleted: true, mode, name };
    },

    /**
     * @param {import("./gcp-compute-config.mjs").NormalizedGcpDeployment} deployment
     */
    async maintainDeployment(deployment) {
      if (deployment.mode === "gcp-cloud-run") {
        return this.deployCloudRun(deployment);
      }
      const { gcp } = deployment;
      const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${gcp.zone}/instances/${gcp.resource_name}`;
      const existing = await this.getLiveDeployment(deployment);
      if (!existing) throw new Error(`GCE instance not found: ${gcp.resource_name}`);
      const labels = { ...gcp.labels, "hdc-maintained": new Date().toISOString().slice(0, 10) };
      await gcpRequest(url, "PATCH", { labels });
      return { maintained: true, mode: "gcp-vm", name: gcp.resource_name, labels };
    },
  };
}
