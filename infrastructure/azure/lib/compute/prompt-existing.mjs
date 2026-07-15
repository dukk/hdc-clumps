import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

/**
 * @param {string} systemId
 * @param {string} detail
 * @param {Record<string, string>} flags
 * @returns {Promise<"skip" | "redeploy" | "destroy">}
 */
export async function promptExistingAzureResourceAction(systemId, detail, flags) {
  if (flags["skip-existing"] !== undefined) return "skip";
  if (flags["redeploy-existing"] !== undefined) return "redeploy";
  if (flags["destroy-existing"] !== undefined) return "destroy";

  if (!stdin.isTTY) {
    stderr.write(
      `${systemId}: resource exists (${detail}); non-interactive deploy defaults to skip. Use --redeploy-existing or --destroy-existing.\n`,
    );
    return "skip";
  }

  const q = `${systemId} already exists (${detail}). [S]kip / [R]edeploy / [D]estroy? [s/R/d] `;
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const raw = (await rl.question(q)).trim().toLowerCase();
    if (raw === "d" || raw === "destroy") return "destroy";
    if (raw === "r" || raw === "redeploy") return "redeploy";
    return "skip";
  } finally {
    rl.close();
  }
}
