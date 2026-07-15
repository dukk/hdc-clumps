import { formatCostEstimateMarkdown } from "hdc/package/cloud-cost-format.mjs";

/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function gcpComputeReportExtraSections(ctx) {
  /** @type {string[]} */
  const sections = [];
  const payload = ctx.stdoutPayload;
  const results = Array.isArray(payload?.results) ? payload.results : [];

  /** @type {string[]} */
  const costLines = ["## Cost estimate"];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const systemId = String(/** @type {{ system_id?: string }} */ (row).system_id ?? "");
    const estimate = /** @type {{ cost_estimate?: import("../../../lib/cloud-cost-format.mjs").CostEstimate }} */ (
      row
    ).cost_estimate;
    if (!estimate) continue;
    costLines.push("");
    costLines.push(`### ${systemId || "deployment"}`);
    costLines.push(...formatCostEstimateMarkdown(estimate));
    const confirmed = /** @type {{ cost_confirmed?: boolean }} */ (row).cost_confirmed;
    if (confirmed === true) costLines.push("_Cost confirmed by operator or --yes._");
    if (ctx.dryRun) costLines.push("_Dry-run: no resources provisioned._");
  }
  if (costLines.length > 1) sections.push(...costLines);

  const created = results.filter(
    (r) => r && typeof r === "object" && /** @type {{ ok?: boolean }} */ (r).ok,
  );
  if (created.length) {
    sections.push("", "## Resources");
    for (const row of created) {
      const r = /** @type {{ system_id?: string; mode?: string; resource_name?: string; region?: string; zone?: string }} */ (
        row
      );
      const loc = r.zone ? `zone ${r.zone}` : r.region ? `region ${r.region}` : "";
      sections.push(
        `- **${r.system_id ?? "?"}** (${r.mode ?? "?"}): \`${r.resource_name ?? "?"}\`${loc ? ` (${loc})` : ""}`,
      );
    }
  }

  return sections;
}
