/**
 * Query Proxmox VE nodes from `clumps/infrastructure/proxmox/config.json` (clusters + hosts),
 * then emit a JSON snapshot on stdout (systems[] for hypervisors and guests). No repo inventory paths are read or written.
 *
 * Diagnostic flags (stdout JSON; skip full cluster snapshot):
 *   --guest <vmid|system-id>   Status, guest-agent ping, optional ICMP/SSH
 *   --find-template <vmid>     Locate QEMU template across cluster nodes
 *   --host-capacity <host-id>  free/df/qm list/pct list via SSH
 *   --failing-only             Emit only stopped guests / unhealthy hypervisor nodes
 *   --reboot-required          Running Linux LXC guests with /var/run/reboot-required
 *   --pending-os-updates       Hypervisor apt upgradable package counts (read-only)
 *   --import-hardware [--yes]  Upsert physical host hardware[] into operations/inventory/systems/pve-*.json
 *   --dry-run                  With --import-hardware: preview sidecar writes without writing
 *
 * Auth: Proxmox API token (see Datacenter → Permissions → API Tokens). Stored in the vault
 * as HDC_PROXMOX_API_TOKEN or per-host HDC_PROXMOX_API_TOKEN_<HOST_ID> (e.g. HDC_PROXMOX_API_TOKEN_HYPERVISOR_A).
 * Env override: HDC_PROXMOX_API_TOKEN. Self-signed TLS: HDC_PROXMOX_TLS_INSECURE=1 or HDC_TLS_INSECURE=1 (global default).
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr as errout, env } from "node:process";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

import {
  automatedInventoryIdFromName,
} from "hdc/package/automated-ids.mjs";
import {
  isProxmoxConfigObject,
  loadProxmoxHostsByCluster,
  proxmoxClusterRefFromHost,
} from "hdc/package/proxmox-config.mjs";
import { vaultTokenKeyForHost, normalizePveAuthorization } from "hdc/package/proxmox-deploy-auth.mjs";
import { parsePveVersionBody } from "hdc/package/pve-version.mjs";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import {
  HDC_TLS_INSECURE_ENV,
  hdcTlsInsecureSourceEnv,
  hdcTlsRejectUnauthorized,
} from "hdc/cli/lib/tls-insecure-env.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import { loadProxmoxPackageConfig } from "hdc/package/proxmox-package-config.mjs";
import { collectProxmoxOutages } from "hdc/package/proxmox-outage-filter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));
const clumpRoot = join(here, "..");
const repoRoot = join(here, "..", "..", "..", "..");

const VAULT_KEY_GLOBAL = "HDC_PROXMOX_API_TOKEN";
const SPEC_TLS_INSECURE = "HDC_PROXMOX_TLS_INSECURE";

/** @param {string} line */
function logUser(line) {
  errout.write(`[proxmox] ${line}\n`);
}

/** @param {string} root @param {string} abs */
function relFromRoot(root, abs) {
  try {
    return relative(root, abs).replace(/\\/g, "/");
  } catch {
    return abs;
  }
}

/**
 * @param {unknown} row
 * @returns {row is Record<string, unknown>}
 */
function isObject(row) {
  return isProxmoxConfigObject(row);
}

/**
 * @param {string} baseUrl
 * @param {string} path e.g. /version (no /api2/json prefix)
 * @param {string} authorization full Authorization header value
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<unknown>}
 */
function pveJsonGet(baseUrl, path, authorization, rejectUnauthorized) {
  const root = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${root}/api2/json${p}`;
  const agent = new https.Agent({ rejectUnauthorized });
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        agent,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          /** @type {unknown} */
          let parsed;
          try {
            parsed = raw.length ? JSON.parse(raw) : null;
          } catch (e) {
            reject(new Error(`Invalid JSON from Proxmox (${res.statusCode}): ${String(e)}`));
            return;
          }
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            const err = new Error(`Proxmox HTTP ${code} ${p}`);
            reject(err);
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * @param {unknown} body
 * @returns {unknown[]}
 */
function pveDataArray(body) {
  if (!isObject(body)) return [];
  const d = body.data;
  return Array.isArray(d) ? d : [];
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function byVmid(a, b) {
  const va = isObject(a) && typeof a.vmid === "number" ? a.vmid : 0;
  const vb = isObject(b) && typeof b.vmid === "number" ? b.vmid : 0;
  return va - vb;
}

async function main() {
  const t0 = Date.now();
  const argv = process.argv.slice(2);
  const failingOnly = argv.includes("--failing-only");

  try {
    const { maybeRunProxmoxMaintenanceQuery } = await import("../lib/proxmox-maintenance-query.mjs");
    const maintenance = await maybeRunProxmoxMaintenanceQuery(argv, clumpRoot);
    if (maintenance) {
      const payload = {
        target,
        verb: "query",
        ...maintenance,
        collected_at: new Date().toISOString(),
      };
      if (maintenance.ok === false) process.exitCode = 1;
      output.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    const { maybeRunProxmoxHardwareImport } = await import("../lib/proxmox-hardware-import.mjs");
    const hardwareImport = await maybeRunProxmoxHardwareImport(argv, clumpRoot);
    if (hardwareImport) {
      const payload = {
        target,
        verb: "query",
        ...hardwareImport,
        collected_at: new Date().toISOString(),
      };
      if (hardwareImport.ok === false) process.exitCode = 1;
      output.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    const { maybeRunProxmoxQueryDiag } = await import("../lib/proxmox-query-diag.mjs");
    const diag = await maybeRunProxmoxQueryDiag(argv, clumpRoot);
    if (diag) {
      const payload = {
        target,
        verb: "query",
        ...diag,
        collected_at: new Date().toISOString(),
      };
      if (diag.ok === false) process.exitCode = 1;
      output.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
  } catch (e) {
    errout.write(`[proxmox] query diag failed: ${/** @type {Error} */ (e).stack || e}\n`);
    process.exitCode = 1;
    return;
  }

  const rejectUnauthorized = hdcTlsRejectUnauthorized(env, SPEC_TLS_INSECURE);
  const tlsInsecureVia = hdcTlsInsecureSourceEnv(env, SPEC_TLS_INSECURE);

  logUser(`query starting — target ${JSON.stringify(target)}`);
  logUser(`repo root: ${repoRoot.replace(/\\/g, "/")}`);
  logUser(
    rejectUnauthorized
      ? `TLS certificate verification is ON (set ${SPEC_TLS_INSECURE}=1 or ${HDC_TLS_INSECURE_ENV}=1 for self-signed node certs).`
      : `TLS certificate verification is OFF (${tlsInsecureVia}=1).`,
  );

  const vault = createVaultAccess(
    vaultDepsFromCli({
      env,
      log: (...a) => errout.write(`${a.join(" ")}\n`),
      error: (...a) => errout.write(`${a.join(" ")}\n`),
      warn: (...a) => errout.write(`${a.join(" ")}\n`),
      defaultVaultPath,
      existsSync,
      readLineQuestion: async (q, opts) => {
        if (opts?.mask) {
          return readLineMasked(q, errout, input);
        }
        const rl = createInterface({ input, output: errout });
        try {
          return await rl.question(q);
        } finally {
          rl.close();
        }
      },
    }),
  );

  /** @type {unknown} */
  let cfg;
  /** @type {string} */
  let configPath;
  /** @type {string} */
  let configRel;
  try {
    const loaded = loadProxmoxPackageConfig(clumpRoot, { publicRoot: repoRoot, env });
    cfg = loaded.data;
    configPath = loaded.path;
    configRel = relFromRoot(repoRoot, configPath);
  } catch (e) {
    errout.write(`${/** @type {Error} */ (e).message}\n`);
    process.exitCode = 1;
    return;
  }

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => logUser(`skip ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    errout.write(
      `[proxmox] No Proxmox hypervisors in clumps/infrastructure/proxmox/config.json (clusters[].hosts[] with id, pve_node, web_ui, ip, ssh).\n`,
    );
    process.exitCode = 1;
    return;
  }

  logUser(
    `Found ${clusterKeys.length} cluster/standalone group(s) from clump config: ${clusterKeys.map((k) => JSON.stringify(k)).join(", ")}`,
  );

  const collectedAt = new Date().toISOString();

  /** @type {Record<string, unknown>[]} */
  const mergedRecords = [];

  /** @type {Set<string>} */
  const guestIdUsed = new Set();

  let hypervisorCount = 0;
  let guestCount = 0;

  for (const ck of clusterKeys) {
    const members = byCluster.get(ck);
    if (!members?.length) continue;
    const lead = members[0];
    logUser(
      `Cluster ${JSON.stringify(ck)}: using API endpoint from config host ${JSON.stringify(lead.id)} (${lead.rel}) → ${lead.apiBase}`,
    );

    const verify = async (/** @type {string} */ token) => {
      try {
        const auth = normalizePveAuthorization(token);
        logUser(`Verifying API token with GET /version on ${lead.apiBase} …`);
        await pveJsonGet(lead.apiBase, "/version", auth, rejectUnauthorized);
        logUser("Proxmox API OK (version endpoint).");
        return true;
      } catch (e) {
        errout.write(
          `[proxmox] Token verification failed (${/** @type {Error} */ (e).message}). Check token, URL, and TLS (${SPEC_TLS_INSECURE}=1 or ${HDC_TLS_INSECURE_ENV}=1 if needed).\n`,
        );
        return false;
      }
    };

    /** @type {string | null} */
    let authorization = null;
    const envTok = String(env.HDC_PROXMOX_API_TOKEN ?? "").trim();
    if (envTok) {
      logUser("Checking HDC_PROXMOX_API_TOKEN from environment …");
      const auth = normalizePveAuthorization(envTok);
      if (await verify(auth)) authorization = auth;
      else logUser("Environment token failed verification; will try vault / prompt.");
    }

    if (!authorization) {
      const data = (await vault.readSecrets({})) ?? {};
      const perKey = vaultTokenKeyForHost(lead.id);
      const perVal = typeof data[perKey] === "string" ? data[perKey].trim() : "";
      const globVal = typeof data[VAULT_KEY_GLOBAL] === "string" ? data[VAULT_KEY_GLOBAL].trim() : "";
      if (perVal) {
        logUser(`Trying vault key ${perKey} (per-host) …`);
        const auth = normalizePveAuthorization(perVal);
        if (await verify(auth)) authorization = auth;
      }
      if (!authorization && globVal) {
        logUser(`Trying vault key ${VAULT_KEY_GLOBAL} …`);
        const auth = normalizePveAuthorization(globVal);
        if (await verify(auth)) authorization = auth;
      }
    }

    if (!authorization) {
      logUser(`No working token yet; vault getSecret ${VAULT_KEY_GLOBAL} (passphrase may be prompted) …`);
      const token = await vault.getSecret(VAULT_KEY_GLOBAL, {
        promptLabel:
          "Proxmox API token (full value: user@realm!tokenid=secret, or prefix with PVEAPIToken=)",
        verify: async (v) => verify(v),
      });
      authorization = normalizePveAuthorization(token);
    }

    if (!authorization) {
      errout.write(`[proxmox] No working API token for cluster group ${JSON.stringify(ck)}.\n`);
      process.exitCode = 1;
      return;
    }

    /** @type {Map<string, string>} */
    const pveNodeToInventory = new Map();
    for (const m of members) pveNodeToInventory.set(m.pveNode, m.id);

    logUser(`GET /cluster/resources?type=vm … (${lead.apiBase})`);
    const resourcesBody = await pveJsonGet(
      lead.apiBase,
      "/cluster/resources?type=vm",
      authorization,
      rejectUnauthorized,
    );
    const resourceRows = pveDataArray(resourcesBody).filter(isObject).sort(byVmid);
    const guests = resourceRows.filter((r) => {
      const typ = typeof r.type === "string" ? r.type : "";
      if (typ !== "qemu" && typ !== "lxc") return false;
      if (r.template === 1) return false;
      return true;
    });
    logUser(`Guests (qemu/lxc, non-template): ${guests.length} in group ${JSON.stringify(ck)}.`);

    /** @type {import("../lib/pve-version.mjs").PveVersionInfo | null} */
    let pveVersion = null;
    try {
      const versionBody = await pveJsonGet(lead.apiBase, "/version", authorization, rejectUnauthorized);
      pveVersion = parsePveVersionBody(versionBody);
      if (pveVersion) {
        logUser(`Proxmox ${JSON.stringify(ck)}: release ${pveVersion.release} (major ${pveVersion.major}).`);
      }
    } catch (e) {
      errout.write(
        `[proxmox] GET /version failed for cluster group ${JSON.stringify(ck)} (${/** @type {Error} */ (e).message}).\n`,
      );
    }

    for (const m of members) {
      logUser(`GET /nodes/${encodeURIComponent(m.pveNode)}/status for host ${JSON.stringify(m.id)} …`);
      let status = null;
      try {
        status = await pveJsonGet(
          lead.apiBase,
          `/nodes/${encodeURIComponent(m.pveNode)}/status`,
          authorization,
          rejectUnauthorized,
        );
      } catch (e) {
        errout.write(
          `[proxmox] Node status failed for ${m.pveNode} (${/** @type {Error} */ (e).message}).\n`,
        );
      }

      const manual = m.host;
      const clusterRef = proxmoxClusterRefFromHost(manual, m.clusterId);

      /** @type {Record<string, unknown>} */
      const hostQuery = {
        collected_at: collectedAt,
        inventory_path: m.rel,
        api_base_used: m.apiBase,
        web_ui: typeof manual.web_ui === "string" ? manual.web_ui : undefined,
        ip: typeof manual.ip === "string" ? manual.ip : undefined,
        pve_node: m.pveNode,
        cluster_inventory_key: ck,
        version: pveVersion
          ? {
              release: pveVersion.release,
              version: pveVersion.version,
              repoid: pveVersion.repoid,
              pve_major: pveVersion.major,
            }
          : undefined,
        node_status: status && isObject(status) ? status.data ?? status : status,
      };

      /** @type {Record<string, unknown>} */
      const hostRecord = {
        kind: "system",
        id: m.id,
        system_class: "physical",
        tags: ["proxmox", "automated"],
        query_last: hostQuery,
      };
      if (clusterRef) hostRecord.proxmox_cluster = clusterRef;

      mergedRecords.push(hostRecord);
      hypervisorCount += 1;
    }

    for (const r of guests) {
      const node = typeof r.node === "string" ? r.node.trim() : "";
      const mappedHost = node ? pveNodeToInventory.get(node) : "";
      if (node && !mappedHost) {
        logUser(
          `WARN: guest vmid ${typeof r.vmid === "number" ? r.vmid : "?"} is on PVE node ${JSON.stringify(node)}, which has no matching inventory hypervisor in this group — hosted_on_system_id omitted.`,
        );
      }
      const typ = typeof r.type === "string" ? r.type : "qemu";
      const prefix = typ === "lxc" ? "ct" : "vm";
      const name =
        (typeof r.name === "string" && r.name.trim()) ||
        (typeof r.vmid === "number" ? `id-${r.vmid}` : "unknown");
      const guestId = automatedInventoryIdFromName(prefix, { name, id: String(r.vmid ?? "") }, guestIdUsed);

      /** @type {Record<string, unknown>} */
      const vh = { ...r };

      /** @type {Record<string, unknown>} */
      const guestRecord = {
        kind: "system",
        id: guestId,
        system_class: "virtual",
        tags: ["proxmox", "automated"],
        hosted_on_system_id: mappedHost || undefined,
        virtual_hardware: vh,
        query_last: { ...r, collected_at: collectedAt, pve_node: node },
      };

      const firstMember = members[0];
      const guestClusterRef = proxmoxClusterRefFromHost(firstMember.host, firstMember.clusterId);
      if (guestClusterRef) guestRecord.proxmox_cluster = guestClusterRef;

      mergedRecords.push(guestRecord);
      guestCount += 1;
    }
  }

  logUser(`Prepared ${mergedRecords.length} system record(s) for stdout JSON (no files written).`);

  const payload = {
    target,
    verb: "query",
    ok: true,
    collected_at: collectedAt,
    hypervisor_count: hypervisorCount,
    guest_count: guestCount,
    cluster_group_count: clusterKeys.length,
    systems: mergedRecords,
    message:
      "Proxmox snapshot from clumps/infrastructure/proxmox/config.json — systems[] on stdout only (inventory paths not used).",
  };

  if (failingOnly) {
    const outages = collectProxmoxOutages(payload);
    const ok = outages.failing_count === 0;
    const failingPayload = {
      ok,
      target,
      verb: "query",
      failing_only: true,
      collected_at: collectedAt,
      failing_count: outages.failing_count,
      failing: outages.failing,
    };
    logUser(`Failing-only: ${outages.failing_count} outage(s).`);
    output.write(`${JSON.stringify(failingPayload, null, 2)}\n`);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logUser(`Finished in ${elapsed}s. JSON summary on stdout for hdc.`);

  errout.write(`\n[proxmox] — Summary —\n`);
  errout.write(
    `Hypervisors: ${hypervisorCount} · Guests (vm/ct): ${guestCount} · Cluster groups: ${clusterKeys.length}\n`,
  );

  output.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((e) => {
  errout.write(`[proxmox] Fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.exitCode = 1;
});
