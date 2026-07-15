#!/usr/bin/env node
/**
 * Health check for n8n (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run n8n health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "n8n",
  family: "docker-lxc",
  probe: { path: "/healthz" },
});
process.exit(payload.ok ? 0 : 1);
