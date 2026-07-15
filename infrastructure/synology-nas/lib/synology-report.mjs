/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function synologyReportExtraSections(ctx) {
  const results = ctx.stdoutPayload?.results ?? ctx.stdoutPayload?.nodes;
  if (!Array.isArray(results) || !results.length) {
    return ["## Synology NAS", "", "_No host results in payload._", ""];
  }

  /** @type {string[]} */
  const lines = ["## Synology NAS", ""];

  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = typeof row.system_id === "string" ? row.system_id : "(unknown)";
    lines.push(`### ${sid}`, "");

    const health = row.health;
    if (health && typeof health === "object" && !Array.isArray(health)) {
      const h = /** @type {Record<string, unknown>} */ (health);
      if (typeof h.dsmVersion === "string") lines.push(`- **DSM:** ${h.dsmVersion}`);
      if (typeof h.uptime === "string") lines.push(`- **Uptime:** ${h.uptime}`);

      const volumes = h.volumes;
      if (Array.isArray(volumes) && volumes.length) {
        lines.push("", "**Volumes**", "", "| Mount | Size | Used | Avail | Use% |", "| --- | --- | --- | --- | --- |");
        for (const v of volumes) {
          if (!v || typeof v !== "object" || Array.isArray(v)) continue;
          const vol = /** @type {Record<string, string>} */ (v);
          lines.push(
            `| ${vol.mount ?? "—"} | ${vol.size ?? "—"} | ${vol.used ?? "—"} | ${vol.avail ?? "—"} | ${vol.usePct ?? "—"} |`,
          );
        }
        lines.push("");
      }

      const raid = h.raid;
      if (raid && typeof raid === "object" && !Array.isArray(raid)) {
        const rd = /** @type {Record<string, unknown>} */ (raid);
        lines.push(`- **RAID degraded:** ${rd.degraded === true ? "yes" : "no"}`);
        const arrays = rd.arrays;
        if (Array.isArray(arrays) && arrays.length) {
          lines.push("", "| Array | Level | State | Devices |", "| --- | --- | --- | --- |");
          for (const a of arrays) {
            if (!a || typeof a !== "object" || Array.isArray(a)) continue;
            const ar = /** @type {Record<string, string>} */ (a);
            lines.push(
              `| ${ar.name ?? "—"} | ${ar.level ?? "—"} | ${ar.state ?? "—"} | ${ar.devices ?? "—"} |`,
            );
          }
          lines.push("");
        }
      }

      const disks = h.disks;
      if (disks && typeof disks === "object" && !Array.isArray(disks)) {
        const dl = /** @type {Record<string, unknown>} */ (disks).lines;
        if (Array.isArray(dl) && dl.length) {
          lines.push("**Disks**", "");
          for (const line of dl.slice(0, 15)) {
            if (typeof line === "string") lines.push(`- ${line}`);
          }
          lines.push("");
        }
      }

      const docker = h.docker;
      if (docker && typeof docker === "object" && !Array.isArray(docker)) {
        const dk = /** @type {Record<string, unknown>} */ (docker);
        lines.push("**Docker / Container Manager**", "");
        if (typeof dk.package === "string") lines.push(`- **Package:** ${dk.package}`);
        if (typeof dk.version === "string") lines.push(`- **Version:** ${dk.version}`);
        lines.push(`- **Running:** ${dk.running === true ? "yes" : "no"}`);
        lines.push(`- **Compose:** ${dk.compose === true ? "yes" : "no"}`);
        lines.push("");
      }
    }

    const steps = row.steps;
    if (steps && typeof steps === "object" && !Array.isArray(steps)) {
      const st = /** @type {Record<string, unknown>} */ (steps);
      const dsm = st.dsm_upgrade;
      if (dsm && typeof dsm === "object" && !Array.isArray(dsm)) {
        const d = /** @type {Record<string, unknown>} */ (dsm);
        lines.push(
          `- **DSM upgrade:** ${d.ok === true ? "ok" : d.ok === false ? "failed" : "—"}${d.rebooted === true ? " (rebooted)" : ""}`,
        );
        const check = d.check;
        if (check && typeof check === "object" && !Array.isArray(check)) {
          const c = /** @type {Record<string, unknown>} */ (check);
          if (typeof c.summary === "string") lines.push(`  - ${c.summary}`);
        }
      }
      const pkg = st.package_upgrade;
      if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
        const p = /** @type {Record<string, unknown>} */ (pkg);
        lines.push(`- **Package upgrade:** ${p.ok === true ? "ok" : p.ok === false ? "failed" : "—"}`);
      }
      const dockerEnsure = st.docker_ensure;
      if (dockerEnsure && typeof dockerEnsure === "object" && !Array.isArray(dockerEnsure)) {
        const d = /** @type {Record<string, unknown>} */ (dockerEnsure);
        lines.push(
          `- **Docker ensure:** ${d.ok === true ? "ok" : d.ok === false ? "failed" : "—"}${typeof d.package === "string" ? ` (${d.package})` : ""}`,
        );
        if (typeof d.dockerVersion === "string") lines.push(`  - version: ${d.dockerVersion}`);
        if (d.composeAvailable === false) lines.push("  - compose plugin not detected");
      }
    }

    if (typeof row.message === "string" && row.message.trim()) {
      lines.push(`- **Message:** ${row.message.trim()}`);
    }
    lines.push("");
  }

  return lines;
}
