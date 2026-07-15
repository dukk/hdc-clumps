/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function postgresqlReportExtraSections(ctx) {
  const lines = ["## PostgreSQL roles", ""];
  const results = ctx.stdoutPayload?.results;
  if (!Array.isArray(results) || !results.length) {
    lines.push("_No instance results._", "");
    return lines;
  }
  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = row.system_id;
    const role = row.role;
    if (typeof sid !== "string") continue;
    lines.push(
      `- **${sid}:** ${typeof role === "string" ? role : "—"}${row.ok === true ? " (ok)" : row.ok === false ? " (failed)" : ""}`,
    );
    if (role === "standby") {
      lines.push(`  - Verify replication: \`hdc run postgresql query\` on ${sid}.`);
    }
  }
  lines.push("");
  return lines;
}
