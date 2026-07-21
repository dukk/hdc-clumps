/**
 * Filter Proxmox cluster snapshot JSON for outage conditions.
 */

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} payload Proxmox query stdout JSON
 */
export function collectProxmoxOutages(payload) {
  const systems = Array.isArray(payload?.systems) ? payload.systems : [];
  /** @type {Record<string, unknown>[]} */
  const failing = [];

  for (const row of systems) {
    if (!isObject(row)) continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const queryLast = isObject(row.query_last) ? row.query_last : null;
    const vh = isObject(row.virtual_hardware) ? row.virtual_hardware : null;

    if (tags.includes("proxmox") && row.system_class === "physical") {
      const nodeStatus = isObject(row.node_status) ? row.node_status : null;
      if (nodeStatus && nodeStatus.status && String(nodeStatus.status).toLowerCase() !== "online") {
        failing.push({
          id,
          kind: "hypervisor",
          status: nodeStatus.status,
          node: queryLast && typeof queryLast.pve_node === "string" ? queryLast.pve_node : null,
          message: `hypervisor node status ${String(nodeStatus.status)}`,
        });
      }
      continue;
    }

    if (row.system_class !== "virtual" || !vh) continue;
    if (vh.template === 1 || vh.template === true) continue;

    const status = typeof vh.status === "string" ? vh.status.trim().toLowerCase() : "";
    if (!status || status === "running") continue;

    failing.push({
      id,
      kind: "guest",
      vmid: vh.vmid ?? queryLast?.vmid ?? null,
      name: typeof vh.name === "string" ? vh.name : id,
      type: typeof vh.type === "string" ? vh.type : null,
      status,
      node:
        (queryLast && typeof queryLast.pve_node === "string" ? queryLast.pve_node : null) ||
        (typeof vh.node === "string" ? vh.node : null),
      message: `guest not running (${status})`,
    });
  }

  failing.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    failing_count: failing.length,
    failing,
  };
}
