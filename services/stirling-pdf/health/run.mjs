#!/usr/bin/env node
/**
 * Health check for stirling-pdf (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run stirling-pdf health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "stirling-pdf",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
