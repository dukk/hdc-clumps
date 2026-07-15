#!/usr/bin/env node
/**
 * Health check for windows-desktop (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run windows-desktop health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "windows-desktop",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
