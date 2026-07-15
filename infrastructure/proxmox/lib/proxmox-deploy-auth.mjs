import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin as input, stderr as errout, env } from "node:process";
import { createVaultAccess, vaultDepsFromCli } from "hdc/cli/lib/vault-access.mjs";
import { readLineMasked } from "hdc/cli/lib/readline-masked.mjs";
import { defaultVaultPath } from "hdc/cli/vault.mjs";
import {
  HDC_TLS_INSECURE_ENV,
  hdcTlsInsecureSourceEnv,
  hdcTlsRejectUnauthorized,
} from "hdc/cli/lib/tls-insecure-env.mjs";
import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { pveJsonRequest } from "./pve-http.mjs";
import {
  apiBaseFromWebUi,
  findProxmoxHostInConfig,
  isProxmoxConfigObject,
  isProxmoxHostDown,
  resolveProxmoxHost,
} from "./proxmox-config.mjs";
import {
  formatPveVersionLog,
  parsePveVersionBody,
  pveProfileForMajor,
  pveVersionFromConfigCluster,
} from "./pve-version.mjs";

export {
  fetchPveVersion,
  formatPveVersionLog,
  parsePveVersionBody,
  pveMajorFromRelease,
  pveProfileForMajor,
  pveVersionFromConfigCluster,
  resolveClusterPveProfile,
} from "./pve-version.mjs";

export { apiBaseFromWebUi, resolveProxmoxHost } from "./proxmox-config.mjs";

const VAULT_KEY_GLOBAL = "HDC_PROXMOX_API_TOKEN";
const SPEC_TLS_INSECURE = "HDC_PROXMOX_TLS_INSECURE";

/**
 * @param {string} hostInventoryId e.g. hypervisor-a
 */
export function vaultTokenKeyForHost(hostInventoryId) {
  return `HDC_PROXMOX_API_TOKEN_${hostInventoryId.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * @param {string} raw
 */
export function normalizePveAuthorization(raw) {
  const t = raw.trim();
  if (!t) return t;
  if (/^PVEAPIToken=/i.test(t)) return t;
  return `PVEAPIToken=${t}`;
}

/**
 * Parse `user@realm!tokenid=secret` or `PVEAPIToken=user@realm!tokenid=secret` (secret is not returned).
 * @param {string} raw
 * @returns {{ userid: string; tokenid: string } | null}
 */
export function parsePveApiTokenValue(raw) {
  const t = String(raw ?? "")
    .trim()
    .replace(/^PVEAPIToken=/i, "");
  const bang = t.indexOf("!");
  const eq = t.lastIndexOf("=");
  if (bang < 1 || eq <= bang) return null;
  const userid = t.slice(0, bang).trim();
  const tokenid = t.slice(bang + 1, eq).trim();
  if (!userid || !tokenid) return null;
  return { userid, tokenid };
}

/**
 * @param {{ userid: string; tokenid: string }} parsed
 */
export function pveTokenAclId(parsed) {
  return `${parsed.userid}!${parsed.tokenid}`;
}

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} vault
 * @param {string} hostId
 * @param {NodeJS.ProcessEnv} [processEnv]
 * @returns {Promise<string | null>}
 */
export async function readProxmoxApiTokenRaw({ vault, hostId, env: processEnv = env }) {
  const envTok = String(processEnv.HDC_PROXMOX_API_TOKEN ?? "").trim();
  if (envTok) return envTok;
  const perKey = vaultTokenKeyForHost(hostId);
  const perVal = String(await vault.getSecret(perKey, { optional: true })).trim();
  if (perVal) return perVal;
  const globVal = String(await vault.getSecret(VAULT_KEY_GLOBAL, { optional: true })).trim();
  return globVal || null;
}

/**
 * GET paths used to verify the hdc API token can run maintain (templates + storage).
 * @param {string} pveNode
 * @param {string} lxcStorage
 */
export function proxmoxMaintainVerifyPaths(pveNode, lxcStorage) {
  const node = encodeURIComponent(pveNode);
  const storage = encodeURIComponent(lxcStorage);
  return [
    "/cluster/resources?type=vm",
    `/nodes/${node}/storage/${storage}/content?content=vztmpl`,
    "/storage",
  ];
}

/**
 * @param {string} baseUrl
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @param {string[]} [verifyPaths] Extra GET paths the token must succeed on (after /version).
 * @returns {Promise<import("./pve-version.mjs").PveVersionInfo | null>}
 */
async function verifyToken(baseUrl, authorization, rejectUnauthorized, verifyPaths = []) {
  const versionBody = await pveJsonRequest(
    "GET",
    baseUrl,
    "/version",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const pveVersion = parsePveVersionBody(versionBody);
  for (const path of verifyPaths) {
    await pveJsonRequest("GET", baseUrl, path, authorization, rejectUnauthorized, undefined);
  }
  return pveVersion;
}

/** @deprecated Prefer proxmoxMaintainVerifyPaths(node, lxcStorage) for template + storage checks. */
export const PROXMOX_MAINTAIN_VERIFY_PATHS = ["/cluster/resources?type=vm"];

/**
 * @param {{ clumpRoot: string; hostId: string; vault?: ReturnType<typeof createVaultAccess>; verifyPaths?: string[]; configCluster?: unknown }} opts
 */
export async function authorizeProxmoxForHost(opts) {
  const { clumpRoot, hostId, vault: vaultIn, verifyPaths = [], configCluster = null } = opts;
  const rejectUnauthorized = hdcTlsRejectUnauthorized(env, SPEC_TLS_INSECURE);
  const tlsNote = hdcTlsInsecureSourceEnv(env, SPEC_TLS_INSECURE);

  const loaded = loadProxmoxPackageConfig(clumpRoot);
  const cfg = loaded.data;
  const host = resolveProxmoxHost(cfg, hostId);
  if (!host) {
    const raw = findProxmoxHostInConfig(cfg, hostId);
    if (raw && isProxmoxHostDown(raw.host)) {
      throw new Error(
        `Proxmox host ${JSON.stringify(hostId)} is marked down in clumps/infrastructure/proxmox/config.json`,
      );
    }
    throw new Error(
      `Unknown Proxmox host id ${JSON.stringify(hostId)} in infrastructure/proxmox/config.json (need clusters[].hosts[] with web_ui)`,
    );
  }

  const vault =
    vaultIn ??
    createVaultAccess(
      vaultDepsFromCli({
        env,
        log: (...a) => errout.write(`${a.join(" ")}\n`),
        error: (...a) => errout.write(`${a.join(" ")}\n`),
        warn: (...a) => errout.write(`${a.join(" ")}\n`),
        defaultVaultPath,
        existsSync,
        readLineQuestion: async (q, qopts) => {
          if (qopts?.mask) {
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

  /** @type {string | null} */
  let authorization = null;
  /** @type {import("./pve-version.mjs").PveVersionInfo | null} */
  let pveVersion = null;

  const envTok = String(env.HDC_PROXMOX_API_TOKEN ?? "").trim();
  if (envTok) {
    const auth = normalizePveAuthorization(envTok);
    try {
      pveVersion = await verifyToken(host.apiBase, auth, rejectUnauthorized, verifyPaths);
      authorization = auth;
    } catch {
      /* try vault */
    }
  }

  if (!authorization) {
    const perKey = vaultTokenKeyForHost(host.id);
    const perVal = String(await vault.getSecret(perKey, { optional: true })).trim();
    const globVal = String(await vault.getSecret(VAULT_KEY_GLOBAL, { optional: true })).trim();
    if (perVal) {
      const auth = normalizePveAuthorization(perVal);
      try {
        pveVersion = await verifyToken(host.apiBase, auth, rejectUnauthorized, verifyPaths);
        authorization = auth;
      } catch {
        /* continue */
      }
    }
    if (!authorization && globVal) {
      const auth = normalizePveAuthorization(globVal);
      try {
        pveVersion = await verifyToken(host.apiBase, auth, rejectUnauthorized, verifyPaths);
        authorization = auth;
      } catch {
        /* continue */
      }
    }
  }

  if (!authorization) {
    const perKey = vaultTokenKeyForHost(host.id);
    const perVal = String(await vault.getSecret(perKey, { optional: true })).trim();
    const hasPerHost = perVal.length > 0;
    const token = await vault.getSecret(hasPerHost ? perKey : VAULT_KEY_GLOBAL, {
      promptLabel: hasPerHost
        ? `Proxmox API token for ${host.id} (user@realm!tokenid=secret, or PVEAPIToken=…)`
        : "Proxmox API token (user@realm!tokenid=secret, or prefix with PVEAPIToken=)",
      verify: async (v) => {
        pveVersion = await verifyToken(
          host.apiBase,
          normalizePveAuthorization(v),
          rejectUnauthorized,
          verifyPaths,
        );
        return true;
      },
    });
    authorization = normalizePveAuthorization(token);
  }

  if (!pveVersion && configCluster) {
    pveVersion = pveVersionFromConfigCluster(configCluster);
  }

  const pveProfile = pveVersion ? pveProfileForMajor(pveVersion.major) : pveProfileForMajor(8);

  return {
    host: {
      id: host.id,
      pveNode: host.pveNode,
      apiBase: host.apiBase,
      rel: "",
    },
    authorization,
    rejectUnauthorized,
    tlsInsecureLabel: tlsNote,
    hdcTlsInsecureEnv: HDC_TLS_INSECURE_ENV,
    specTlsInsecure: SPEC_TLS_INSECURE,
    pveVersion,
    pveProfile,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} opts.hostId
 * @param {ReturnType<typeof createVaultAccess>} [opts.vault]
 * @param {unknown} [opts.configCluster]
 */
export async function fetchPveVersionForHost(opts) {
  const auth = await authorizeProxmoxForHost({ ...opts, verifyPaths: [] });
  if (auth.pveVersion) return { version: auth.pveVersion, profile: auth.pveProfile };
  const cfg = JSON.parse(readFileSync(join(opts.clumpRoot, "config.json"), "utf8"));
  if (!isProxmoxConfigObject(cfg)) return null;
  const clusters = cfg.clusters;
  if (!Array.isArray(clusters)) return null;
  for (const cl of clusters) {
    if (!isProxmoxConfigObject(cl)) continue;
    const hosts = cl.hosts;
    if (!Array.isArray(hosts)) continue;
    for (const h of hosts) {
      if (isProxmoxConfigObject(h) && h.id === opts.hostId) {
        const v = pveVersionFromConfigCluster(cl);
        if (v) return { version: v, profile: pveProfileForMajor(v.major) };
      }
    }
  }
  return null;
}

/** Paths used by storage maintain (list/create storage). */
export const PROXMOX_STORAGE_VERIFY_PATHS = ["/storage"];

/**
 * Try each cluster member until API auth succeeds.
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {{ id: string }[]} opts.members
 * @param {ReturnType<typeof createVaultAccess>} [opts.vault]
 * @param {(line: string) => void} opts.warn
 * @param {string[]} [opts.verifyPaths]
 * @param {unknown} [opts.configCluster]
 * @param {(line: string) => void} [opts.log]
 */
export async function authorizeProxmoxForClusterMembers(opts) {
  const {
    clumpRoot,
    members,
    vault,
    warn,
    verifyPaths = PROXMOX_MAINTAIN_VERIFY_PATHS,
    configCluster = null,
    log,
  } = opts;
  for (const m of members) {
    try {
      const auth = await authorizeProxmoxForHost({
        clumpRoot,
        hostId: m.id,
        vault,
        verifyPaths,
        configCluster,
      });
      if (log && auth.pveVersion) {
        log(`Proxmox ${JSON.stringify(auth.host.id)}: ${formatPveVersionLog(auth.pveVersion, auth.pveProfile)}.`);
      }
      return auth;
    } catch (e) {
      warn(`API auth via ${JSON.stringify(m.id)} failed: ${/** @type {Error} */ (e).message || e}`);
    }
  }
  return null;
}
