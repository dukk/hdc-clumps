import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { clusterConfigByKey, isProxmoxConfigObject, loadProxmoxHostsByCluster } from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  proxmoxMaintainVerifyPaths,
} from "./proxmox-deploy-auth.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import { pveFormBody, pveJsonRequest, pveDataArray } from "./pve-http.mjs";
import { STORAGE_UPDATE_KEYS } from "./pve-version.mjs";

const DEFAULT_STORAGE_IDS = ["nas-a", "nas-b"];

/** API response fields that are not part of storage.cfg create/update. */
const STORAGE_READONLY_KEYS = new Set([
  "digest",
  "shared",
  "used",
  "avail",
  "active",
  "enabled",
  "content-types",
]);

/** Keys compared when ensuring storage matches desired config. */
const STORAGE_COMPARE_KEYS = [
  "type",
  "server",
  "export",
  "share",
  "path",
  "content",
  "options",
  "domain",
  "username",
  "maxfiles",
  "subdir",
  "is_mountpoint",
  "preallocation",
  "format",
  "blocksize",
  "sparse",
  "mountpoint",
  "prune-backups",
  "nodes",
  "disable",
];

/**
 * @param {unknown} cfg
 */
export function storageMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const storage = provision.storage;
  if (!isProxmoxConfigObject(storage)) return true;
  return storage.enabled !== false && storage.enabled !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {string[]}
 */
export function storageIdsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return [...DEFAULT_STORAGE_IDS];
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return [...DEFAULT_STORAGE_IDS];
  const storage = provision.storage;
  if (!isProxmoxConfigObject(storage)) return [...DEFAULT_STORAGE_IDS];
  const ids = storage.ids;
  if (!Array.isArray(ids) || !ids.length) return [...DEFAULT_STORAGE_IDS];
  return ids.map((id) => String(id).trim()).filter(Boolean);
}

/**
 * @param {unknown} cfg
 * @returns {string | null}
 */
export function storageDiscoverHostIdFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return null;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return null;
  const storage = provision.storage;
  if (!isProxmoxConfigObject(storage)) return null;
  const h = storage.discover_from_host;
  return typeof h === "string" && h.trim() ? h.trim() : null;
}

/**
 * @param {unknown} cfg
 * @returns {Record<string, unknown>[] | null}
 */
export function storageTargetsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return null;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return null;
  const storage = provision.storage;
  if (!isProxmoxConfigObject(storage)) return null;
  const targets = storage.targets;
  if (!Array.isArray(targets) || !targets.length) return null;
  return targets.filter(isProxmoxConfigObject);
}

/**
 * @param {unknown} value
 */
function normalizeContent(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

/**
 * @param {Record<string, unknown>} row
 */
function storageRowToSpec(row) {
  /** @type {Record<string, unknown>} */
  const spec = {};
  const id = typeof row.storage === "string" ? row.storage.trim() : "";
  if (!id) return null;
  spec.storage = id;
  for (const [k, v] of Object.entries(row)) {
    if (STORAGE_READONLY_KEYS.has(k) || k === "storage") continue;
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    spec[k] = v;
  }
  return spec;
}

/**
 * @param {Record<string, unknown>} spec
 * @param {string[]} pveNodes
 */
export function storageSpecForNodes(spec, pveNodes) {
  const out = { ...spec };
  if (pveNodes.length) {
    out.nodes = pveNodes.join(",");
  } else {
    delete out.nodes;
  }
  return out;
}

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
export function storageSpecsMatch(a, b) {
  for (const key of STORAGE_COMPARE_KEYS) {
    const va = a[key];
    const vb = b[key];
    if (key === "content") {
      if (normalizeContent(va) !== normalizeContent(vb)) return false;
      continue;
    }
    if (key === "nodes") {
      const na = normalizeNodes(va);
      const nb = normalizeNodes(vb);
      if (na !== nb) return false;
      continue;
    }
    const sa = va === undefined || va === null ? "" : String(va).trim();
    const sb = vb === undefined || vb === null ? "" : String(vb).trim();
    if (sa !== sb) return false;
  }
  return true;
}

/**
 * @param {unknown} nodes
 */
function normalizeNodes(nodes) {
  const s = String(nodes ?? "").trim();
  if (!s) return "";
  return s
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

/**
 * @param {Record<string, unknown>} spec
 * @param {Record<string, string>} [extra]
 * @param {{ forUpdate?: boolean; profile?: import("./pve-version.mjs").PveProfile }} [opts]
 */
export function storageSpecToFormFields(spec, extra = {}, opts = {}) {
  const forUpdate = opts.forUpdate === true;
  const updateKeys = opts.profile?.storageUpdateKeys ?? STORAGE_UPDATE_KEYS;
  /** @type {Record<string, string | number | boolean>} */
  const fields = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === "password_vault_key") continue;
    if (forUpdate) {
      if (k === "storage" || k === "type") continue;
      if (!updateKeys.has(k)) continue;
    }
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean" || typeof v === "number") {
      fields[k] = v;
    } else {
      const s = String(v).trim();
      if (s) fields[k] = s;
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!v) continue;
    if (forUpdate && !updateKeys.has(k)) continue;
    fields[k] = v;
  }
  return fields;
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function fetchPveStorageList(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest("GET", apiBase, "/storage", authorization, rejectUnauthorized, undefined);
  return pveDataArray(body);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string[]} ids
 */
export function pickStorageSpecsFromRows(rows, ids) {
  /** @type {Record<string, Record<string, unknown>>} */
  const byId = new Map();
  for (const row of rows) {
    const spec = storageRowToSpec(row);
    if (!spec || typeof spec.storage !== "string") continue;
    byId.set(spec.storage, spec);
  }
  /** @type {Record<string, unknown>[]} */
  const picked = [];
  for (const id of ids) {
    const spec = byId.get(id);
    if (spec) picked.push(spec);
  }
  return picked;
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {Record<string, unknown>[]} opts.desiredSpecs
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} opts.log
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @param {import("./pve-version.mjs").PveProfile} [opts.profile]
 */
export async function ensurePveStorageSpecs(opts) {
  const { apiBase, authorization, rejectUnauthorized, desiredSpecs, dryRun = false, log, vault, profile } =
    opts;
  /** @type {Record<string, unknown>[]} */
  let existing;
  try {
    existing = await fetchPveStorageList(apiBase, authorization, rejectUnauthorized);
  } catch (e) {
    log(`storage list failed: ${/** @type {Error} */ (e).message || e}`);
    return { ok: false };
  }
  let ok = true;

  for (const desired of desiredSpecs) {
    const id = typeof desired.storage === "string" ? desired.storage : "";
    if (!id) continue;

    const row = existing.find((r) => r.storage === id);
    const passwordKey =
      typeof desired.password_vault_key === "string" ? desired.password_vault_key.trim() : "";
    /** @type {Record<string, string>} */
    const extra = {};
    if (passwordKey && vault) {
      const data = (await vault.readSecrets({})) ?? {};
      const pw = typeof data[passwordKey] === "string" ? data[passwordKey].trim() : "";
      if (pw) extra.password = pw;
    }

    if (!row) {
      log(`storage ${JSON.stringify(id)} missing — will create (${desired.type ?? "?"})${dryRun ? " [dry-run]" : ""}.`);
      if (!dryRun) {
        try {
          const form = pveFormBody(storageSpecToFormFields(desired, extra));
          await pveJsonRequest("POST", apiBase, "/storage", authorization, rejectUnauthorized, form);
          log(`storage ${JSON.stringify(id)} created.`);
        } catch (e) {
          ok = false;
          log(`storage ${JSON.stringify(id)} create failed: ${/** @type {Error} */ (e).message || e}`);
        }
      }
      continue;
    }

    const existingSpec = storageRowToSpec(row);
    if (!existingSpec) continue;

    if (storageSpecsMatch(existingSpec, desired)) {
      log(`storage ${JSON.stringify(id)} OK.`);
      continue;
    }

    log(`storage ${JSON.stringify(id)} differs — will update${dryRun ? " [dry-run]" : ""}.`);
    if (!dryRun) {
      try {
          const form = pveFormBody(storageSpecToFormFields(desired, extra, { forUpdate: true, profile }));
        await pveJsonRequest(
          "PUT",
          apiBase,
          `/storage/${encodeURIComponent(id)}`,
          authorization,
          rejectUnauthorized,
          form,
        );
        log(`storage ${JSON.stringify(id)} updated.`);
      } catch (e) {
        ok = false;
        log(`storage ${JSON.stringify(id)} update failed: ${/** @type {Error} */ (e).message || e}`);
      }
    }
  }

  return { ok };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} [opts.warn]
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function runProxmoxStorageMaintain(opts) {
  const { clumpRoot, log, warn = log, vault, dryRun = false } = opts;
  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";

  if (!existsSync(configPath)) {
    log(`Missing ${configRel} — copy config.example.json before maintain.`);
    return { ok: false };
  }

  /** @type {unknown} */
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    log(`Invalid JSON in ${configRel}: ${/** @type {Error} */ (e).message}`);
    return { ok: false };
  }

  if (!storageMaintainEnabledFromConfig(cfg)) {
    log("storage maintain disabled (provision.storage.enabled=false).");
    return { ok: true };
  }

  const storageIds = storageIdsFromConfig(cfg);
  const configTargets = storageTargetsFromConfig(cfg);
  const discoverHostId = storageDiscoverHostIdFromConfig(cfg);
  const lxcStorage = lxcTemplateStorageFromConfig(cfg);

  /** @type {Map<string, Record<string, unknown>>} */
  const configCanonicalById = new Map();
  if (configTargets) {
    for (const t of configTargets) {
      const id = typeof t.storage === "string" ? t.storage.trim() : "";
      if (id) configCanonicalById.set(id, { ...t });
    }
    log(`Using ${configCanonicalById.size} storage target(s) from config.`);
  }

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    log(`No hypervisors in ${configRel}.`);
    return { ok: false };
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const sharedCanonicalById = new Map(configCanonicalById);

  let ok = true;

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;
    const pveNodes = members.map((m) => m.pveNode).filter(Boolean);
    log(`Cluster ${JSON.stringify(clusterKey)}: ensure storage ${storageIds.join(", ")} (nodes: ${pveNodes.join(", ")}) …`);

    /** @type {Map<string, Record<string, unknown>>} */
    const canonicalById = new Map(sharedCanonicalById);

    const lead = members[0];
    const configCluster = clusterConfigByKey(cfg, clusterKey);
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn,
      log,
      configCluster,
      verifyPaths: proxmoxMaintainVerifyPaths(lead.pveNode, lxcStorage),
    });
    if (!auth) {
      ok = false;
      warn(`Skipping cluster ${JSON.stringify(clusterKey)} — no API token with Datacenter.Storage.* access.`);
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let desiredSpecs = [];

    for (const id of storageIds) {
      if (canonicalById.has(id)) {
        desiredSpecs.push(storageSpecForNodes(canonicalById.get(id), pveNodes));
        continue;
      }

      try {
        const rows = await fetchPveStorageList(
          auth.host.apiBase,
          auth.authorization,
          auth.rejectUnauthorized,
        );
        const discovered = pickStorageSpecsFromRows(rows, [id]);
        if (discovered.length) {
          const spec = storageSpecForNodes(discovered[0], pveNodes);
          canonicalById.set(id, discovered[0]);
          sharedCanonicalById.set(id, discovered[0]);
          desiredSpecs.push(spec);
          log(`Discovered storage ${JSON.stringify(id)} from ${JSON.stringify(auth.host.id)}.`);
        }
      } catch (e) {
        warn(`Discover ${JSON.stringify(id)} failed: ${/** @type {Error} */ (e).message || e}`);
      }
    }

    let missing = storageIds.filter((id) => !desiredSpecs.some((s) => s.storage === id));
    for (const id of missing.slice()) {
      const ref = sharedCanonicalById.get(id);
      if (!ref) continue;
      canonicalById.set(id, ref);
      desiredSpecs.push(storageSpecForNodes(ref, pveNodes));
      log(`Using storage ${JSON.stringify(id)} from reference definition (discovered earlier or config).`);
    }
    missing = storageIds.filter((id) => !desiredSpecs.some((s) => s.storage === id));
    if (missing.length) {
      if (discoverHostId) {
        const preferred = members.find((m) => m.id === discoverHostId);
        if (preferred && preferred.id !== auth.host.id) {
          try {
            const altAuth = await authorizeProxmoxForClusterMembers({
              clumpRoot,
              members: [preferred],
              vault,
              warn,
              verifyPaths: proxmoxMaintainVerifyPaths(preferred.pveNode, lxcStorage),
            });
            if (altAuth) {
              const rows = await fetchPveStorageList(
                altAuth.host.apiBase,
                altAuth.authorization,
                altAuth.rejectUnauthorized,
              );
              for (const id of missing.slice()) {
                const discovered = pickStorageSpecsFromRows(rows, [id]);
                if (discovered.length) {
                  canonicalById.set(id, discovered[0]);
                  sharedCanonicalById.set(id, discovered[0]);
                  desiredSpecs.push(storageSpecForNodes(discovered[0], pveNodes));
                  log(`Discovered storage ${JSON.stringify(id)} from ${JSON.stringify(discoverHostId)}.`);
                }
              }
            }
          } catch (e) {
            warn(`Discover via ${JSON.stringify(discoverHostId)} failed: ${/** @type {Error} */ (e).message || e}`);
          }
        }
      }

      const stillMissing = storageIds.filter((id) => !desiredSpecs.some((s) => s.storage === id));
      if (stillMissing.length) {
        ok = false;
        warn(
          `Cluster ${JSON.stringify(clusterKey)}: no definition for ${stillMissing.join(", ")} — add provision.storage.targets in config or create on a reference host first.`,
        );
        continue;
      }
    }

    const result = await ensurePveStorageSpecs({
      apiBase: auth.host.apiBase,
      authorization: auth.authorization,
      rejectUnauthorized: auth.rejectUnauthorized,
      desiredSpecs,
      dryRun,
      log,
      vault,
      profile: auth.pveProfile,
    });
    if (!result.ok) ok = false;
  }

  if (ok) log("NAS storage connections OK on all cluster groups.");
  else log("One or more storage checks failed — see warnings above.");

  return { ok };
}
