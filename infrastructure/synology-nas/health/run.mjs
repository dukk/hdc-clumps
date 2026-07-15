#!/usr/bin/env node
/**
 * Health check for synology-nas (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run synology-nas health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "synology-nas",
  family: "synology",
});
process.exit(payload.ok ? 0 : 1);
