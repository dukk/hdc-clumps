#!/usr/bin/env node
/**
 * Health check for kali-desktop (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run kali-desktop health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "kali-desktop",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
