#!/usr/bin/env node
/**
 * Health check for redis (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run redis health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "redis",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
