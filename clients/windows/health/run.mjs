#!/usr/bin/env node
/**
 * Health check for windows (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run windows health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "windows",
  family: "client",
});
process.exit(payload.ok ? 0 : 1);
