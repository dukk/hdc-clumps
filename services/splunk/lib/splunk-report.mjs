/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function splunkReportExtraSections(ctx) {
  const lines = ["## Splunk Free (standalone)", ""];
  const results = ctx.stdoutPayload?.results;
  if (!Array.isArray(results) || !results.length) {
    lines.push("_No instance results._", "");
    return lines;
  }
  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = row.system_id;
    if (typeof sid !== "string") continue;
    lines.push(
      `- **${sid}:** standalone${row.ok === true ? " (ok)" : row.ok === false ? " (failed)" : ""}`,
    );
    lines.push(`  - Web UI: https://<host>:8000 (Splunk Free, 500 MB/day indexing cap).`);
    lines.push(`  - Query: \`hdc run splunk query\`.`);
  }
  lines.push("");
  return lines;
}
