#!/usr/bin/env node
/**
 * Health check for uptime-kuma (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run uptime-kuma health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "uptime-kuma",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
