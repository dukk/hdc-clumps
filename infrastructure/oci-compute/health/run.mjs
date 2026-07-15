#!/usr/bin/env node
/**
 * Health check for oci-compute (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run oci-compute health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "oci-compute",
  family: "infra-api",
});
process.exit(payload.ok ? 0 : 1);
