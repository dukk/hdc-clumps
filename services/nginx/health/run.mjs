#!/usr/bin/env node
/**
 * Health check for nginx (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run nginx health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "nginx",
  family: "self-edge",
});
process.exit(payload.ok ? 0 : 1);
