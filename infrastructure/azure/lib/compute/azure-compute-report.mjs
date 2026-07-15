import { formatCostEstimateMarkdown } from "hdc/package/cloud-cost-format.mjs";
import { deployCostConfirmed } from "hdc/package/deploy-cost-confirm.mjs";

/**
 * @param {import("../../../lib/operation-report.mjs").OperationReportContext} ctx
 * @returns {string[]}
 */
export function azureComputeReportExtraSections(ctx) {
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

  const anyConfirmed = ctx.argvFlags?.includes("--yes");
  if (anyConfirmed && !sections.length) {
    sections.push("## Cost estimate", "_Deploy ran with --yes (per-deployment estimates in run summary)._");
  }

  const created = results.filter(
    (r) => r && typeof r === "object" && /** @type {{ ok?: boolean }} */ (r).ok,
  );
  if (created.length) {
    sections.push("", "## Resources");
    for (const row of created) {
      const r = /** @type {{ system_id?: string; mode?: string; resource_name?: string; resource_group?: string }} */ (
        row
      );
      sections.push(
        `- **${r.system_id ?? "?"}** (${r.mode ?? "?"}): \`${r.resource_name ?? "?"}\` in RG \`${r.resource_group ?? "?"}\``,
      );
    }
  }

  return sections;
}
