/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function piHoleReportExtraSections(ctx) {
  const lines = ["## Pi-hole access", ""];
  const results = ctx.stdoutPayload?.results ?? ctx.stdoutPayload?.instances;
  if (!Array.isArray(results) || !results.length) {
    lines.push("_No instance results._", "");
    return lines;
  }
  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = row.system_id;
    const ip = row.ip;
    if (typeof sid !== "string") continue;
    if (typeof ip === "string" && ip.trim()) {
      lines.push(`- **${sid}:** http://${ip.trim()}/admin/`);
    } else {
      lines.push(`- **${sid}:** set IP in inventory after deploy, then open \`http://<ip>/admin/\``);
    }
  }
  lines.push("");
  return lines;
}
