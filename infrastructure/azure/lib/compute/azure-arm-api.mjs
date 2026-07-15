import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";

const ARM_API = "https://management.azure.com";
const ARM_VERSION = "2024-03-01";
const ACI_VERSION = "2023-05-01";
const NETWORK_VERSION = "2023-11-01";

/**
 * @param {string} subscriptionId
 * @param {string} resourceGroup
 */
export function rgId(subscriptionId, resourceGroup) {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken
 * @param {string} opts.subscriptionId
 */
export function createAzureArmClient(opts) {
  const { getToken, subscriptionId } = opts;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function armRequest(method, path, body) {
    const token = await getToken();
    const url = path.startsWith("http") ? path : `${ARM_API}${path}`;
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = url.includes("api-version") ? url : `${url}${sep}api-version=${ARM_VERSION}`;

    const res = await fetch(fullUrl, {
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
        if (!res.ok) throw new Error(`ARM ${method} ${path} failed (${res.status})`);
        return { raw: text };
      }
    }
    if (!res.ok) {
      const err = json.error;
      const detail =
        err && typeof err === "object" && "message" in err
          ? String(/** @type {{ message?: string }} */ (err).message)
          : `HTTP ${res.status}`;
      throw new Error(`ARM ${method} ${path}: ${detail}`);
    }
    return json;
  }

  return {
    armRequest,
    subscriptionId,

    /**
     * @param {string} resourceGroup
     * @param {string} location
     * @param {Record<string, string>} tags
     */
    async ensureResourceGroup(resourceGroup, location, tags) {
      const path = `${rgId(subscriptionId, resourceGroup)}`;
      try {
        await armRequest("GET", path);
        return { created: false, resource_group: resourceGroup };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("ResourceGroupNotFound") && !msg.includes("404")) throw e;
      }
      await armRequest("PUT", path, { location, tags });
      return { created: true, resource_group: resourceGroup };
    },

    /**
     * @param {string} resourceGroup
     * @param {string} name
     */
    async getResource(resourceGroup, providerPath) {
      const path = `${rgId(subscriptionId, resourceGroup)}/providers/${providerPath}`;
      try {
        return await armRequest("GET", path);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("404") || msg.includes("NotFound")) return null;
        throw e;
      }
    },

    /**
     * @param {string} resourceGroup
     * @param {string} name
     */
    async deleteResource(resourceGroup, providerPath) {
      const path = `${rgId(subscriptionId, resourceGroup)}/providers/${providerPath}`;
      await armRequest("DELETE", path);
    },

    /**
     * @param {import("./azure-compute-config.mjs").ReturnType<typeof import("./azure-compute-config.mjs").normalizeAzureComputeConfig>["deployments"][number]} deployment
     * @param {string[]} sshPublicKeys
     */
    async deployVm(deployment, sshPublicKeys) {
      const { azure } = deployment;
      const rg = azure.resource_group;
      const loc = azure.location;
      await this.ensureResourceGroup(rg, loc, azure.tags);

      const vmName = azure.resource_name;
      const vnetName = azure.vnet_name;
      const subnetName = azure.subnet_name;

      const vnetPath = `Microsoft.Network/virtualNetworks/${vnetName}`;
      const existingVnet = await this.getResource(rg, vnetPath);
      if (!existingVnet) {
        const vnetUrl = `${ARM_API}${rgId(subscriptionId, rg)}/providers/${vnetPath}?api-version=${NETWORK_VERSION}`;
        await armRequest("PUT", vnetUrl.replace(ARM_API, ""), {
          location: loc,
          tags: azure.tags,
          properties: {
            addressSpace: { addressPrefixes: ["10.42.0.0/16"] },
            subnets: [{ name: subnetName, properties: { addressPrefix: "10.42.1.0/24" } }],
          },
        });
      }

      let pipName = "";
      if (azure.public_ip) {
        pipName = `${vmName}-pip`;
        const pipPath = `Microsoft.Network/publicIPAddresses/${pipName}`;
        const pipUrl = `${ARM_API}${rgId(subscriptionId, rg)}/providers/${pipPath}?api-version=${NETWORK_VERSION}`;
        await armRequest("PUT", pipUrl.replace(ARM_API, ""), {
          location: loc,
          tags: azure.tags,
          sku: { name: "Standard" },
          properties: { publicIPAllocationMethod: "Static" },
        });
      }

      const nicName = `${vmName}-nic`;
      const nicPath = `Microsoft.Network/networkInterfaces/${nicName}`;
      const ipConfigs = [
        {
          name: "ipconfig1",
          properties: {
            subnet: {
              id: `${rgId(subscriptionId, rg)}/providers/Microsoft.Network/virtualNetworks/${vnetName}/subnets/${subnetName}`,
            },
            ...(pipName
              ? {
                  publicIPAddress: {
                    id: `${rgId(subscriptionId, rg)}/providers/Microsoft.Network/publicIPAddresses/${pipName}`,
                  },
                }
              : {}),
          },
        },
      ];
      const nicUrl = `${ARM_API}${rgId(subscriptionId, rg)}/providers/${nicPath}?api-version=${NETWORK_VERSION}`;
      await armRequest("PUT", nicUrl.replace(ARM_API, ""), {
        location: loc,
        tags: azure.tags,
        properties: { ipConfigurations: ipConfigs },
      });

      const image = azure.image;
      const publisher = String(image.publisher ?? "Canonical");
      const offer = String(image.offer ?? "0001-com-ubuntu-server-jammy");
      const sku = String(image.sku ?? "22_04-lts-gen2");
      const version = String(image.version ?? "latest");

      const cloudInit = [
        "#cloud-config",
        "package_update: true",
        "packages:",
        "  - qemu-guest-agent",
        "ssh_authorized_keys:",
        ...sshPublicKeys.map((k) => `  - ${k}`),
        "users:",
        "  - default",
        `  - name: ${azure.admin_username}`,
        "    sudo: ALL=(ALL) NOPASSWD:ALL",
        "    shell: /bin/bash",
        "    ssh_authorized_keys:",
        ...sshPublicKeys.map((k) => `      - ${k}`),
      ].join("\n");

      const vmPath = `Microsoft.Compute/virtualMachines/${vmName}`;
      const vmUrl = `${ARM_API}${rgId(subscriptionId, rg)}/providers/${vmPath}?api-version=${ARM_VERSION}`;
      const vmBody = {
        location: loc,
        tags: { ...azure.tags, "hdc-mode": "azure-vm", "hdc-system-id": deployment.systemId },
        properties: {
          hardwareProfile: { vmSize: azure.vm_size || "Standard_B2s" },
          storageProfile: {
            imageReference: { publisher, offer, sku, version },
            osDisk: {
              createOption: "FromImage",
              managedDisk: { storageAccountType: "Premium_LRS" },
              diskSizeGB: azure.os_disk_gb,
            },
          },
          osProfile: {
            computerName: vmName.slice(0, 15),
            adminUsername: azure.admin_username,
            linuxConfiguration: {
              disablePasswordAuthentication: true,
              ssh: {
                publicKeys: sshPublicKeys.map((key) => ({
                  path: `/home/${azure.admin_username}/.ssh/authorized_keys`,
                  keyData: key,
                })),
              },
            },
            customData: Buffer.from(cloudInit, "utf8").toString("base64"),
          },
          networkProfile: {
            networkInterfaces: [
              {
                id: `${rgId(subscriptionId, rg)}/providers/Microsoft.Network/networkInterfaces/${nicName}`,
                properties: { primary: true },
              },
            ],
          },
        },
      };
      const vm = await armRequest("PUT", vmUrl.replace(ARM_API, ""), vmBody);

      return {
        resource_name: vmName,
        resource_group: rg,
        location: loc,
        mode: "azure-vm",
        vm_id: typeof vm.id === "string" ? vm.id : undefined,
      };
    },

    /**
     * @param {import("./azure-compute-config.mjs").ReturnType<typeof import("./azure-compute-config.mjs").normalizeAzureComputeConfig>["deployments"][number]} deployment
     */
    async deployAci(deployment) {
      const { azure } = deployment;
      const rg = azure.resource_group;
      const loc = azure.location;
      await this.ensureResourceGroup(rg, loc, azure.tags);

      const groupName = azure.resource_name;
      const containers = azure.containers.length
        ? azure.containers
        : [{ name: "app", image: "mcr.microsoft.com/azuredocs/aci-helloworld:latest", ports: [80] }];

      /** @type {object[]} */
      const containerDefs = [];
      for (const c of containers) {
        if (!c || typeof c !== "object") continue;
        const name = String(/** @type {{ name?: string }} */ (c).name ?? "app");
        const image = String(/** @type {{ image?: string }} */ (c).image ?? "");
        const ports = Array.isArray(/** @type {{ ports?: number[] }} */ (c).ports)
          ? /** @type {{ ports: number[] }} */ (c).ports
          : [80];
        containerDefs.push({
          name,
          properties: {
            image,
            resources: {
              requests: { cpu: azure.cpu, memoryInGB: azure.memory_gb },
            },
            ports: ports.map((p) => ({ port: p, protocol: "TCP" })),
          },
        });
      }

      const aciPath = `Microsoft.ContainerInstance/containerGroups/${groupName}`;
      const aciUrl = `${ARM_API}${rgId(subscriptionId, rg)}/providers/${aciPath}?api-version=${ACI_VERSION}`;
      const body = {
        location: loc,
        tags: { ...azure.tags, "hdc-mode": "azure-aci", "hdc-system-id": deployment.systemId },
        properties: {
          osType: "Linux",
          restartPolicy: "Always",
          ipAddress: {
            type: "Public",
            ports: containerDefs.flatMap((c) =>
              (c.properties.ports ?? []).map((/** @type {{ port: number }} */ p) => ({
                protocol: "TCP",
                port: p.port,
              })),
            ),
          },
          containers: containerDefs,
        },
      };
      const aci = await armRequest("PUT", aciUrl.replace(ARM_API, ""), body);
      const ip =
        aci.properties &&
        typeof aci.properties === "object" &&
        "ipAddress" in aci.properties &&
        aci.properties.ipAddress &&
        typeof aci.properties.ipAddress === "object" &&
        "ip" in aci.properties.ipAddress
          ? String(/** @type {{ ip?: string }} */ (aci.properties.ipAddress).ip ?? "")
          : "";

      return {
        resource_name: groupName,
        resource_group: rg,
        location: loc,
        mode: "azure-aci",
        fqdn: ip,
        container_group_id: typeof aci.id === "string" ? aci.id : undefined,
      };
    },

    /**
     * @param {import("./azure-compute-config.mjs").ReturnType<typeof import("./azure-compute-config.mjs").normalizeAzureComputeConfig>["deployments"][number]} deployment
     */
    async getLiveDeployment(deployment) {
      const { azure, mode } = deployment;
      const rg = azure.resource_group;
      const name = azure.resource_name;
      if (mode === "azure-vm") {
        const vm = await this.getResource(rg, `Microsoft.Compute/virtualMachines/${name}`);
        if (!vm) return null;
        const power =
          vm.properties &&
          typeof vm.properties === "object" &&
          "provisioningState" in vm.properties
            ? String(/** @type {{ provisioningState?: string }} */ (vm.properties).provisioningState ?? "")
            : "unknown";
        return { exists: true, mode, name, provisioning_state: power, id: vm.id };
      }
      const aci = await this.getResource(rg, `Microsoft.ContainerInstance/containerGroups/${name}`);
      if (!aci) return null;
      const state =
        aci.properties &&
        typeof aci.properties === "object" &&
        "provisioningState" in aci.properties
          ? String(/** @type {{ provisioningState?: string }} */ (aci.properties).provisioningState ?? "")
          : "unknown";
      return { exists: true, mode, name, provisioning_state: state, id: aci.id };
    },

    /**
     * @param {import("./azure-compute-config.mjs").ReturnType<typeof import("./azure-compute-config.mjs").normalizeAzureComputeConfig>["deployments"][number]} deployment
     */
    async deleteDeployment(deployment) {
      const { azure, mode } = deployment;
      const rg = azure.resource_group;
      const name = azure.resource_name;
      if (mode === "azure-vm") {
        await this.deleteResource(rg, `Microsoft.Compute/virtualMachines/${name}`);
        try {
          await this.deleteResource(rg, `Microsoft.Network/networkInterfaces/${name}-nic`);
        } catch {
          /* optional */
        }
        try {
          await this.deleteResource(rg, `Microsoft.Network/publicIPAddresses/${name}-pip`);
        } catch {
          /* optional */
        }
        return { deleted: true, mode, name };
      }
      await this.deleteResource(rg, `Microsoft.ContainerInstance/containerGroups/${name}`);
      return { deleted: true, mode, name };
    },

    /**
     * @param {import("./azure-compute-config.mjs").ReturnType<typeof import("./azure-compute-config.mjs").normalizeAzureComputeConfig>["deployments"][number]} deployment
     */
    async maintainDeployment(deployment) {
      const { azure, mode } = deployment;
      const rg = azure.resource_group;
      const name = azure.resource_name;
      if (mode === "azure-aci") {
        return this.deployAci(deployment);
      }
      const path = `${rgId(subscriptionId, rg)}/providers/Microsoft.Compute/virtualMachines/${name}`;
      const existing = await this.getResource(rg, `Microsoft.Compute/virtualMachines/${name}`);
      if (!existing) throw new Error(`VM not found: ${name}`);
      await armRequest("PATCH", path, { tags: { ...azure.tags, "hdc-maintained": new Date().toISOString() } });
      return { maintained: true, mode, name, resource_path: path };
    },
  };
}

/**
 * @returns {string[]}
 */
export function loadOperatorSshPublicKeys() {
  const { publicKeyLines } = discoverLocalSshMaterial();
  return [...publicKeyLines];
}
