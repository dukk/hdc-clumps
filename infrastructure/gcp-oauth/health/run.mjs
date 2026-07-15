#!/usr/bin/env node
/**
 * Health check for gcp-oauth (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run gcp-oauth health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "gcp-oauth",
  family: "infra-api",
});
process.exit(payload.ok ? 0 : 1);
