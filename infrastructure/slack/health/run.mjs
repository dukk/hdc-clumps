#!/usr/bin/env node
/**
 * Health check for slack (infra-api: config loaded).
 *
 * Usage: hdc run infrastructure slack health --
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "slack",
  family: "infra-api",
});
process.exit(payload.ok ? 0 : 1);
