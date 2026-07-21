/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function nginxWafReportExtraSections(ctx) {
  const lines = ["## Nginx WAF / certificates", ""];
  const results = ctx.stdoutPayload?.results;
  if (!Array.isArray(results) || !results.length) {
    lines.push("_No node results._", "");
    return lines;
  }
  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = row.system_id;
    if (typeof sid !== "string") continue;
    const step = row.step;
    const certs = row.certificates;
    let detail = "";
    if (typeof step === "string") detail = `step=${step}`;
    if (certs && typeof certs === "object" && !Array.isArray(certs)) {
      const c = /** @type {Record<string, unknown>} */ (certs);
      if (Array.isArray(c.obtained) && c.obtained.length) {
        detail += (detail ? "; " : "") + `certs obtained: ${c.obtained.length}`;
      }
      if (Array.isArray(c.expanded) && c.expanded.length) {
        detail += (detail ? "; " : "") + `certs expanded: ${c.expanded.length}`;
      }
    }
    if (typeof row.synced_to === "string") {
      detail += (detail ? "; " : "") + `synced to ${row.synced_to}`;
    }
    lines.push(`- **${sid}:** ${detail || (row.ok === true ? "ok" : row.ok === false ? "failed" : "—")}`);
  }
  lines.push("");
  return lines;
}
