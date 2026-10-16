#!/usr/bin/env node
/**
 * Health check for jevos: GET /health, unauthenticated POST must be 401,
 * authenticated POST /v1/systemone (key from vault) must return a noul probability.
 *
 * Usage: hdc run service jevos health -- [--instance a] [--no-auth-probe]
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import { createPackageVaultAccess } from "hdc/package/package-vault-access.mjs";
import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";
import { apiKeyVaultKey, guestIpFromLxc, resolveJevosDeployments, serverPort } from "../lib/deployments.mjs";
import { probeJevos } from "../lib/jevos-http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const verb = basename(here);
const clumpRoot = join(here, "..");

async function main() {
  const cfg = loadClumpConfigFromClumpRoot(clumpRoot, { exampleRel: "clumps/services/jevos/config.example.json" });
  const flags = parseArgvFlags(process.argv.slice(2));
  const authProbe = flagGet(flags, "no-auth-probe") === undefined;
  const deployments = resolveJevosDeployments(cfg.data, flags);
  /** @type {ReturnType<typeof createPackageVaultAccess> | null} */
  let vault = null;
  if (authProbe) {
    vault = createPackageVaultAccess();
    await vault.unlock({});
  }
  const results = [];
  for (const d of deployments) {
    const ip = guestIpFromLxc(d.proxmox?.lxc);
    if (!ip) {
      results.push({ system_id: d.systemId, ok: false, message: "no static ip in proxmox.lxc.ip_config" });
      continue;
    }
    let apiKey = null;
    if (vault) {
      const v = String((await vault.getSecret(apiKeyVaultKey(d.server), { optional: true })) ?? "").trim();
      apiKey = v && v !== "undefined" ? v : null;
    }
    const probe = await probeJevos(`http://${ip}:${serverPort(d.server)}`, { apiKey });
    errout.write(`[hdc] ${target} ${verb}: ${d.systemId} ${probe.ok ? "OK" : "FAIL"} ${JSON.stringify(probe)}\n`);
    results.push({ system_id: d.systemId, ...probe });
  }
  const ok = results.every((r) => r.ok);
  process.stdout.write(`${JSON.stringify({ ok, target, verb, results }, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ${target} ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, target, verb, message: String(e?.message || e) }, null, 2)}\n`);
  process.exitCode = 1;
});
