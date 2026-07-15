import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NAGIOS_CENTRAL_SYSTEM_ID,
  NAGIOS_CLUSTER_NODE_IDS,
} from "hdc/package/deploy-inventory.mjs";

/** Default logical cluster id (override with `primary_proxmox_cluster_id` in config.json). */
export const PRIMARY_PROXMOX_CLUSTER_INVENTORY_ID = "example-proxmox-cluster";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root (parent of `clumps/`). */
export function nagiosRepoRoot() {
  return join(__dirname, "..", "..", "..", "..");
}

export function nagiosServiceConfigPath(root = nagiosRepoRoot()) {
  return join(root, "clumps", "services", "nagios", "config.json");
}

/**
 * @param {string} root
 */
export function readNagiosServiceConfig(root) {
  const p = nagiosServiceConfigPath(root);
  if (!existsSync(p)) {
    throw new Error(`Missing Nagios clump config: ${p} (copy clumps/services/nagios/config.example.json)`);
  }
  const raw = JSON.parse(readFileSync(p, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid Nagios config JSON: ${p}`);
  }
  return /** @type {Record<string, unknown>} */ (raw);
}

/**
 * @param {string} root
 */
export function primaryProxmoxClusterId(root) {
  const c = readNagiosServiceConfig(root);
  const v = c.primary_proxmox_cluster_id;
  return typeof v === "string" && v.trim() ? v.trim() : "example-proxmox-cluster";
}

/**
 * @param {string} root
 */
export function nagiosNrpeNodeIds(root) {
  const c = readNagiosServiceConfig(root);
  const arr = c.nrpe_node_ids;
  if (Array.isArray(arr) && arr.length) return arr.map(String);
  return [...NAGIOS_CLUSTER_NODE_IDS];
}

/**
 * Document passed to `resolveCentral` (must include `nagios.central`, `access`, `auth`).
 * @param {string} root
 */
export function centralClusterDocument(root) {
  const c = readNagiosServiceConfig(root);
  const doc = c.central_cluster_document;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(
      `${nagiosServiceConfigPath(root)}: set object central_cluster_document (see config.example.json)`,
    );
  }
  return /** @type {Record<string, unknown>} */ (doc);
}

/**
 * @param {string} root
 * @returns {Record<string, unknown>[]}
 */
export function nagiosMonitoredSystems(root) {
  const c = readNagiosServiceConfig(root);
  const arr = c.monitored_systems;
  if (!Array.isArray(arr) || !arr.length) {
    throw new Error(`${nagiosServiceConfigPath(root)}: monitored_systems must be a non-empty array`);
  }
  return arr.map((x) =>
    x && typeof x === "object" && !Array.isArray(x) ? /** @type {Record<string, unknown>} */ (x) : {},
  );
}

export { NAGIOS_CENTRAL_SYSTEM_ID };
