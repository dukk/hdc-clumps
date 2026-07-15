#!/usr/bin/env node
/**
 * Health check for vaultwarden (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run vaultwarden health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "vaultwarden",
  family: "docker-lxc",
  probe: { path: "/alive" },
});
process.exit(payload.ok ? 0 : 1);
