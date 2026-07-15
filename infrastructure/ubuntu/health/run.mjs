#!/usr/bin/env node
/**
 * Health check for ubuntu (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run ubuntu health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "ubuntu",
  family: "client",
});
process.exit(payload.ok ? 0 : 1);
