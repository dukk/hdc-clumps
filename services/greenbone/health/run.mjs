#!/usr/bin/env node
/**
 * Health check for greenbone (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run greenbone health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "greenbone",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
