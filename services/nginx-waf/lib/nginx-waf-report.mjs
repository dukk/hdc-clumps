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
      const obtained = /** @type {Record<string, unknown>} */ (certs).obtained;
      if (Array.isArray(obtained) && obtained.length) {
        detail += (detail ? "; " : "") + `certs obtained: ${obtained.length}`;
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
