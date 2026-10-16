#!/usr/bin/env node
/**
 * Health check: live FreePBX query (fwconsole + admin HTTP).
 *
 * Usage: hdc run service freepbx health -- [--instance a]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const query = join(here, "..", "query", "run.mjs");
const r = spawnSync(process.execPath, [query, ...process.argv.slice(2), "--live"], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
