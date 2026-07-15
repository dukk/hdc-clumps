#!/usr/bin/env node
/**
 * Health check for smtp2go (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run smtp2go health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "smtp2go",
  family: "infra-api",
});
process.exit(payload.ok ? 0 : 1);
