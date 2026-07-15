#!/usr/bin/env node
/**
 * Health check for step-ca (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run step-ca health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "step-ca",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
