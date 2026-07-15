import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

import { flagGet } from "hdc/package/parse-argv-flags.mjs";

/**
 * Whether teardown should run without prompting.
 * @param {Record<string, string>} flags
 */
export function teardownConfirmed(flags) {
  return flagGet(flags, "yes", "y") !== undefined;
}

/**
 * @param {Record<string, string>} flags
 */
export function teardownDryRun(flags) {
  return flagGet(flags, "dry-run", "dry_run") !== undefined;
}

/**
 * @param {string} systemId
 * @param {string} detail Human-safe description (vmid, node, host, …).
 * @param {Record<string, string>} flags
 * @returns {Promise<boolean>} true to proceed with destroy
 */
export async function confirmTeardown(systemId, detail, flags) {
  if (teardownDryRun(flags)) return false;
  if (teardownConfirmed(flags)) return true;
  if (!stdin.isTTY) {
    throw new Error(
      `${systemId}: non-interactive teardown requires --yes (would destroy: ${detail})`,
    );
  }
  const q = `Destroy ${systemId} (${detail})? [y/N] `;
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const raw = (await rl.question(q)).trim().toLowerCase();
    return raw === "y" || raw === "yes";
  } finally {
    rl.close();
  }
}
