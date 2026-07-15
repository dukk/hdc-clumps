#!/usr/bin/env node
/**
 * Health check for immich (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run immich health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "immich",
  family: "synology",
});
process.exit(payload.ok ? 0 : 1);
