#!/usr/bin/env node
/**
 * Health check for homepage (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run homepage health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "homepage",
  family: "docker-lxc",
  probe: { path: "/" },
});
process.exit(payload.ok ? 0 : 1);
