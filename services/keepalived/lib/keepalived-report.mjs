/**
 * @param {ReturnType<typeof import("./deployments.mjs").keepalivedGlobalSettings>} global
 */
export function keepalivedPayloadMeta(global) {
  return {
    router_id: global.routerId,
    auth_pass_vault_key: global.authPassVaultKey,
  };
}

/**
 * @param {object} payload
 * @returns {import("../../../lib/operation-report.mjs").ReportExtraSection[]}
 */
export function keepalivedReportExtraSections(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const lines = results.map((r) => {
    const sid = typeof r.system_id === "string" ? r.system_id : "?";
    const kind = typeof r.deployment_kind === "string" ? r.deployment_kind : "";
    const ok = r.ok === true ? "ok" : "failed";
    return `- **${sid}** (${kind || "node"}): ${ok}`;
  });
  if (!lines.length) return [];
  return [{ title: "Deployments", body: lines.join("\n") }];
}
