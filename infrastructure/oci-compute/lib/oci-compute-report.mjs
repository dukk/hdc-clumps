/**
 * @param {Record<string, unknown>} payload
 */
export function ociComputeReportExtraSections(payload) {
  /** @type {import("../../../lib/operation-report.mjs").OperationReportSection[]} */
  const sections = [];
  const summary = payload.plan_summary;
  if (Array.isArray(summary) && summary.length) {
    sections.push({
      title: "Plan summary",
      body: summary.map((row) => {
        if (!row || typeof row !== "object") return "- (unknown)";
        const r = /** @type {{ kind?: string; resource_id?: string; action?: string }} */ (row);
        return `- ${r.action ?? "?"} ${r.kind ?? "?"} ${r.resource_id ?? "?"}`;
      }),
    });
  }
  return sections;
}
