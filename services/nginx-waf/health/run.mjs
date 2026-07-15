#!/usr/bin/env node
/**
 * Health check for nginx-waf edge pair (LAN listen + optional Host probes).
 *
 * Usage: hdc run nginx-waf health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "nginx-waf",
  family: "self-edge",
  probe: { path: "/", hostname: "hdc.dukk.org" },
});
process.exit(payload.ok ? 0 : 1);
