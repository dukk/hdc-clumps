/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function bindReportExtraSections(ctx) {
  const lines = ["## BIND zones / replication", ""];
  const results = ctx.stdoutPayload?.results;
  if (!Array.isArray(results) || !results.length) {
    lines.push("_No zone or SOA results in payload._", "");
    return lines;
  }
  for (const r of results) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = /** @type {Record<string, unknown>} */ (r);
    const sid = row.system_id;
    const role = row.role;
    const zone = row.zone;
    if (typeof sid !== "string") continue;
    let line = `- **${sid}**`;
    if (typeof role === "string") line += ` (${role})`;
    if (row.serial_match === true) line += ": SOA serial match";
    else if (row.serial_match === false) line += ": SOA serial mismatch";
    else if (row.ok === true) line += ": ok";
    else if (row.ok === false) line += ": failed";
    if (typeof zone === "string") line += ` — zone \`${zone}\``;
    lines.push(line);
  }
  lines.push("");
  return lines;
}
