/**
 * Parse --section entra|compute|all (default: entra for deploy/maintain/query).
 * @param {Record<string, string>} flags
 * @param {{ defaultSection?: "entra" | "compute" | "all"; allowAll?: boolean }} [opts]
 * @returns {"entra" | "compute" | "all"}
 */
export function resolveAzureSection(flags, opts = {}) {
  const allowAll = opts.allowAll !== false;
  const def = opts.defaultSection ?? "entra";
  const raw = String(flags.section ?? flags.domain ?? def)
    .trim()
    .toLowerCase();
  if (raw === "entra" || raw === "apps" || raw === "graph") return "entra";
  if (raw === "compute" || raw === "arm") return "compute";
  if (raw === "all" && allowAll) return "all";
  if (raw === "all" && !allowAll) {
    throw new Error("--section all is not valid for this verb; use entra or compute");
  }
  throw new Error(`Invalid --section ${raw}; expected entra, compute${allowAll ? ", or all" : ""}`);
}
