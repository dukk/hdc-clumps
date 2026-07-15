#!/usr/bin/env node
/**
 * Health check for cloudflare (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run cloudflare health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "cloudflare",
  family: "infra-api",
});
process.exit(payload.ok ? 0 : 1);
