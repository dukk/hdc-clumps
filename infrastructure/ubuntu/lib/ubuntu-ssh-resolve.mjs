import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listSshTargetsFromSidecar } from "hdc/cli/lib/users-bootstrap-hdc.mjs";

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} clumpRoot
 * @param {string} hostId bootstrap_hosts[].id
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ user: string; host: string } | null}
 */
export function resolveUbuntuBootstrapSsh(clumpRoot, hostId, env) {
  const path = join(clumpRoot, "config.json");
  if (!existsSync(path)) return null;
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(cfg)) return null;
  const hosts = cfg.bootstrap_hosts;
  if (!Array.isArray(hosts)) return null;
  for (const h of hosts) {
    if (!isObject(h)) continue;
    const id = typeof h.id === "string" ? h.id.trim() : "";
    if (id !== hostId.trim()) continue;
    const targets = listSshTargetsFromSidecar(h, env);
    return targets[0] ?? null;
  }
  return null;
}
