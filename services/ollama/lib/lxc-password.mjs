import { stdin, stderr, env } from "node:process";

import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";

/**
 * @param {unknown} lxc
 */
function passwordFromLxcConfig(lxc) {
  if (!lxc || typeof lxc !== "object" || Array.isArray(lxc)) return null;
  const p = /** @type {Record<string, unknown>} */ (lxc).password;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * Root password for a new LXC: config `proxmox.lxc.password`, `--password`, or masked prompt.
 * @param {string} systemId
 * @param {number} vmid
 * @param {Record<string, unknown>} lxc
 * @param {Record<string, string>} flags
 * @param {{ cached?: string | null; setCached?: (v: string) => void }} [opts]
 */
export async function resolveLxcRootPassword(systemId, vmid, lxc, flags, opts = {}) {
  const fromFlag = flagGet(flags, "password");
  if (fromFlag) return fromFlag;

  const fromCfg = passwordFromLxcConfig(lxc);
  if (fromCfg) return fromCfg;

  const fromEnv = String(env.HDC_PROXMOX_LXC_ROOT_PASSWORD ?? "").trim();
  if (fromEnv) return fromEnv;

  if (opts.cached) return opts.cached;

  if (!stdin.isTTY) {
    throw new Error(
      `${systemId}: cannot prompt for LXC root password (not a TTY). Set proxmox.lxc.password in config, HDC_PROXMOX_LXC_ROOT_PASSWORD in .env, or pass --password after --`,
    );
  }

  const line = await readLineMasked(
    `Root password for ${systemId} (vmid ${vmid}, Proxmox LXC root): `,
    stderr,
    stdin,
  );
  const password = line.trim();
  if (!password) {
    throw new Error(`${systemId}: LXC root password is required to create the container`);
  }
  opts.setCached?.(password);
  return password;
}
