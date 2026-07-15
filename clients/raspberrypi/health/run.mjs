#!/usr/bin/env node
/**
 * Health check for raspberrypi (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run raspberrypi health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "raspberrypi",
  family: "client",
});
process.exit(payload.ok ? 0 : 1);
