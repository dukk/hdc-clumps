/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function solidtimeReportExtraSections(ctx) {
  const lines = ["## SolidTime access", ""];
  const results = ctx.stdoutPayload?.results ?? ctx.stdoutPayload?.instances;
  if (!Array.isArray(results) || !results.length) {
    lines.push("_No instance results._", "");
    return lines;
  }
  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = row.system_id;
    const url = row.url;
    const ip = row.ip;
    if (typeof sid !== "string") continue;
    if (typeof url === "string" && url.trim()) {
      lines.push(`- **${sid}:** ${url.trim()} — register your first account in the web UI.`);
    } else if (typeof ip === "string" && ip.trim()) {
      lines.push(`- **${sid}:** http://${ip.trim()}/ — register your first account in the web UI.`);
    } else {
      lines.push(`- **${sid}:** set IP in inventory after deploy, then open the app URL and register.`);
    }
  }
  lines.push("");
  return lines;
}
