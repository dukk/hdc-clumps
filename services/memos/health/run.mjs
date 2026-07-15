#!/usr/bin/env node
/**
 * Health check for memos (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run memos health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "memos",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
