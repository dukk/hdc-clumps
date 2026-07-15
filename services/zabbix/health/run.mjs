#!/usr/bin/env node
/**
 * Health check for zabbix (layered DNS / WAF / direct / guest).
 *
 * Usage: hdc run zabbix health -- [--instance a]
 */
import { runServiceHealth, clumpRootFromHealthScript } from "hdc/package/service-health/run-health.mjs";

const payload = await runServiceHealth({
  clumpRoot: clumpRootFromHealthScript(import.meta.url),
  packageId: "zabbix",
  family: "docker-lxc",
});
process.exit(payload.ok ? 0 : 1);
