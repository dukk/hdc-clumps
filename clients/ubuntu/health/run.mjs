#!/usr/bin/env node
/**
 * Health check for client-ubuntu (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run client-ubuntu health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "client-ubuntu",
  family: "client",
});
process.exit(payload.ok ? 0 : 1);
