#!/usr/bin/env node
/**
 * Health check for a2a-registry (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run a2a-registry health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "a2a-registry",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
