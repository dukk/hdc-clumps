import { join } from "node:path";

import { repoRoot } from "hdc/cli/paths.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { normalizeOciComputeConfig } from "../../../infrastructure/oci-compute/lib/oci-config.mjs";
import { createOciComputeRunContext } from "../../../infrastructure/oci-compute/lib/oci-run-context.mjs";
import { createOciComputeHostProvisioner } from "../../../infrastructure/oci-compute/lib/oci-compute-host-provisioner.mjs";
import { iaasHost, ociListItems } from "../../../infrastructure/oci-compute/lib/oci-api.mjs";
import { probeGuestSshUser } from "hdc/package/guest-ssh-exec.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} ociBaseRaw
 * @param {Record<string, unknown>} deployment
 */
export function resolveOciInstanceForDeployment(ociBaseRaw, deployment) {
  const ociBlock = isObject(deployment.oci) ? deployment.oci : {};
  const instanceId =
    typeof ociBlock.instance_id === "string" && ociBlock.instance_id.trim()
      ? ociBlock.instance_id.trim()
      : "";
  if (!instanceId) {
    throw new Error(`${deployment.system_id ?? "deployment"}: oci.instance_id is required`);
  }

  const base = normalizeOciComputeConfig(ociBaseRaw);
  const fromBase = base.instancesById.get(instanceId);
  const systemId = String(deployment.system_id ?? deployment.systemId ?? fromBase?.system_id ?? "");

  const subnetId =
    typeof ociBlock.subnet_id === "string" && ociBlock.subnet_id.trim()
      ? ociBlock.subnet_id.trim()
      : fromBase?.subnet_id ?? "";
  const imageOcid =
    typeof ociBlock.image_ocid === "string" && ociBlock.image_ocid.trim()
      ? ociBlock.image_ocid.trim()
      : fromBase?.image_ocid ?? "";
  const nsgIds = Array.isArray(ociBlock.nsg_ids)
    ? ociBlock.nsg_ids.map((v) => String(v).trim()).filter(Boolean)
    : fromBase?.nsg_ids ?? [];

  if (!subnetId) throw new Error(`${systemId}: oci subnet_id required (deployment or oci-compute config)`);
  if (!imageOcid) throw new Error(`${systemId}: oci image_ocid required (deployment or oci-compute config)`);

  return {
    id: instanceId,
    managed: fromBase?.managed !== false,
    system_id: systemId,
    subnet_id: subnetId,
    nsg_ids: nsgIds,
    shape:
      typeof ociBlock.shape === "string" && ociBlock.shape.trim()
        ? ociBlock.shape.trim()
        : fromBase?.shape ?? "VM.Standard.E2.1",
    ocpus:
      typeof ociBlock.ocpus === "number"
        ? ociBlock.ocpus
        : (fromBase?.ocpus ?? Number(ociBlock.ocpus)) || 1,
    memory_gb:
      typeof ociBlock.memory_gb === "number"
        ? ociBlock.memory_gb
        : (fromBase?.memory_gb ?? Number(ociBlock.memory_gb)) || 1,
    boot_volume_gb:
      typeof ociBlock.boot_volume_gb === "number"
        ? ociBlock.boot_volume_gb
        : (fromBase?.boot_volume_gb ?? Number(ociBlock.boot_volume_gb)) || 50,
    image_ocid: imageOcid,
    assign_public_ip: ociBlock.assign_public_ip !== false && fromBase?.assign_public_ip !== false,
    tags: { ...(fromBase?.tags ?? {}), ...(isObject(ociBlock.tags) ? ociBlock.tags : {}) },
  };
}

/**
 * @param {import("../../../infrastructure/oci-compute/lib/oci-api.mjs").OciClient} client
 * @param {string} instanceOcid
 */
export async function resolveOciInstancePublicIp(client, instanceOcid) {
  const host = iaasHost(client.region);
  const attachments = await client.request({
    host,
    path: "/20160918/vnicAttachments",
    query: { compartmentId: client.compartmentId, instanceId: instanceOcid },
  });
  const items = ociListItems(attachments);
  for (const att of items) {
    if (!isObject(att)) continue;
    const vnicId = typeof att.vnicId === "string" ? att.vnicId : "";
    if (!vnicId) continue;
    const vnic = await client.request({
      host: iaasHost(client.region),
      path: `/20160918/vnics/${encodeURIComponent(vnicId)}`,
    });
    const publicIp = typeof vnic.publicIp === "string" ? vnic.publicIp.trim() : "";
    if (publicIp) return publicIp;
  }
  return null;
}

/**
 * @param {string} host
 * @param {string} [user]
 * @param {(line: string) => void} [log]
 */
export async function waitForSsh(host, user = "ubuntu", log = () => {}) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (probeGuestSshUser(user, host)) {
      log(`SSH ready ${user}@${host}`);
      return true;
    }
    log(`waiting for SSH ${user}@${host} …`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.deployment
 * @param {Record<string, string>} opts.flags
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 */
export async function provisionOciVmForDeployment(opts) {
  const root = repoRoot();
  const ociRoot = join(root, "clumps", "infrastructure", "oci-compute");
  const loaded = loadClumpConfigFromClumpRoot(ociRoot, {
    exampleRel: "clumps/infrastructure/oci-compute/config.example.json",
    log: (line) => opts.log.info(line),
  });
  const instance = resolveOciInstanceForDeployment(loaded.data, {
    system_id: opts.deployment.systemId,
    oci: opts.deployment.oci,
  });
  const { config: baseConfig, client } = await createOciComputeRunContext(loaded.data);
  const prov = createOciComputeHostProvisioner({
    mode: "oci-vm",
    baseConfig,
    client,
    deployment: instance,
  });
  const provisionResult = await prov.createVm(opts.log, { name: instance.system_id });
  if (!provisionResult.ok) {
    return { ok: false, message: provisionResult.message, instance };
  }

  const live = await client.request({
    host: iaasHost(client.region),
    path: "/20160918/instances",
    query: { compartmentId: client.compartmentId },
  });
  const rows = ociListItems(live);
  const match = rows.find((row) => {
    if (!isObject(row)) return false;
    const tags = isObject(row.freeformTags) ? row.freeformTags : {};
    return tags["hdc-resource-id"] === instance.id;
  });
  const ocid = isObject(match) && typeof match.id === "string" ? match.id : null;
  let publicIp = null;
  if (ocid) {
    try {
      publicIp = await resolveOciInstancePublicIp(client, ocid);
    } catch {
      publicIp = null;
    }
  }

  const configure = isObject(opts.deployment.configure) ? opts.deployment.configure : {};
  const ssh = isObject(configure.ssh) ? configure.ssh : {};
  const sshHost =
    (typeof ssh.host === "string" && ssh.host.trim()) || publicIp || null;
  const sshUser = typeof ssh.user === "string" && ssh.user.trim() ? ssh.user.trim() : "ubuntu";

  return {
    ok: true,
    message: provisionResult.message,
    instance,
    ocid,
    public_ip: publicIp,
    ssh_host: sshHost,
    ssh_user: sshUser,
    provision: provisionResult,
  };
}
