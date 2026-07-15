import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

/**
 * @param {string} systemId
 * @param {number} vmid
 * @param {string} node
 * @param {string} [name]
 * @returns {Promise<"skip" | "redeploy">}
 */
export async function promptExistingGuestAction(systemId, vmid, node, name) {
  const label = name ? `${name} ` : "";
  const q = `${systemId}: ${label}vmid ${vmid} on ${node} already exists. [s]kip / [r]edeploy (reinstall in CT)? `;
  if (!stdin.isTTY) {
    stderr.write(
      `[hdc] nextcloud: not a TTY — skipping ${systemId} (use --redeploy-existing or --skip-existing).\n`,
    );
    return "skip";
  }
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const raw = (await rl.question(q)).trim().toLowerCase();
    if (raw.startsWith("r")) return "redeploy";
    return "skip";
  } finally {
    rl.close();
  }
}
