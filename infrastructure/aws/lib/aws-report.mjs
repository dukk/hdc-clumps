import { costMetaFromPayload, renderCostEstimateMarkdown } from "hdc/package/cost-report.mjs";

/** @typedef {import("../../../lib/operation-report.mjs").OperationReportContext} OperationReportContext */

/**
 * @param {OperationReportContext} ctx
 * @returns {string[]}
 */
export function awsReportExtraSections(ctx) {
  /** @type {string[]} */
  const lines = [];

  const meta = costMetaFromPayload(
    ctx.stdoutPayload && typeof ctx.stdoutPayload === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.stdoutPayload)
      : null,
  );
  lines.push(...renderCostEstimateMarkdown(meta));

  const payload = ctx.stdoutPayload;
  const plan = payload && typeof payload === "object" ? payload.plan_summary : null;
  if (Array.isArray(plan) && plan.length) {
    lines.push("## Plan summary", "");
    lines.push("| Kind | Resource | Action |");
    lines.push("| --- | --- | --- |");
    for (const row of plan) {
      if (!row || typeof row !== "object") continue;
      const r = /** @type {Record<string, string>} */ (row);
      lines.push(`| ${r.kind ?? ""} | \`${r.resource_id ?? ""}\` | ${r.action ?? ""} |`);
    }
    lines.push("");
  }

  const results = payload && typeof payload === "object" ? payload.results : null;
  if (Array.isArray(results) && results.length) {
    lines.push("## Apply results", "");
    for (const r of results) {
      if (!r || typeof r !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (r);
      const id = row.resource_id ?? row.id ?? "?";
      const ok = row.ok === false || row.error ? "failed" : "ok";
      lines.push(`- \`${id}\`: ${ok}${row.error ? ` — ${row.error}` : ""}`);
    }
    lines.push("");
  }

  return lines;
}
