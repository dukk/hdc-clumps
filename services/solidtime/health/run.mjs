#!/usr/bin/env node
/**
 * Health check for solidtime (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run solidtime health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "solidtime",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
