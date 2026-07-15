import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  discoverLocalSshMaterial,
  resolveProxmoxSshPassword,
  shellSingleQuote,
  sshBashLc,
  sshReachableWithPubkey,
  sshSpawn,
} from "hdc/cli/lib/ssh-host-access.mjs";
import { clusterConfigByKey, isProxmoxConfigObject, loadProxmoxHostsByCluster } from "./proxmox-config.mjs";
import {
  authorizeProxmoxForHost,
  parsePveApiTokenValue,
  pveTokenAclId,
  proxmoxMaintainVerifyPaths,
  readProxmoxApiTokenRaw,
  vaultTokenKeyForHost,
} from "./proxmox-deploy-auth.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import {
  HDC_PROXMOX_API_PRIVILEGES,
  pveProfileForMajor,
  resolveClusterPveProfile,
} from "./pve-version.mjs";

export { HDC_PROXMOX_API_PRIVILEGES } from "./pve-version.mjs";

/** Proxmox role assigned to the hdc API token (created/updated via pveum over SSH). */
export const HDC_PROXMOX_API_ROLE = "HDCMaintain";

const DEFAULT_API_TOKEN_USERID = "root@pam";
const HDC_TOKEN_PREFIX = "hdc";

/**
 * @param {string} hostname
 * @returns {string}
 */
export function hdcProxmoxTokenIdFromHostname(hostname) {
  const base = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = base || "host";
  const id = `${HDC_TOKEN_PREFIX}-${slug}`;
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id)) {
    return `${HDC_TOKEN_PREFIX}-host`;
  }
  return id;
}

/**
 * @param {unknown} cfg
 * @returns {string}
 */
export function apiTokenUseridFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return DEFAULT_API_TOKEN_USERID;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return DEFAULT_API_TOKEN_USERID;
  const apiToken = provision.api_token;
  if (!isProxmoxConfigObject(apiToken)) return DEFAULT_API_TOKEN_USERID;
  const userid = apiToken.userid;
  return typeof userid === "string" && userid.trim() ? userid.trim() : DEFAULT_API_TOKEN_USERID;
}

/**
 * @param {string} userid
 * @param {string} tokenid
 */
export function pveumCreateOrRegenerateTokenScript(userid, tokenid) {
  const u = shellSingleQuote(userid);
  const t = shellSingleQuote(tokenid);
  const tGrep = shellSingleQuote(tokenid);
  return [
    `if pveum user token list ${u} --output-format json 2>/dev/null | grep -qF ${tGrep}; then`,
    `  pveum user token modify ${u} ${t} --regenerate 1 --privsep 1 --output-format json`,
    "else",
    `  pveum user token add ${u} ${t} --privsep 1 --output-format json`,
    "fi",
  ].join("\n");
}

/**
 * @param {string} stdout
 * @param {string} userid
 * @param {string} tokenid
 * @returns {string | null}
 */
export function parsePveumTokenSecret(stdout, userid, tokenid) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = /** @type {Record<string, unknown>} */ (parsed);
  const data = root.data;
  const bag = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : root;
  const secret = bag.value;
  if (typeof secret !== "string" || !secret.trim()) return null;
  return `${userid}!${tokenid}=${secret.trim()}`;
}

/**
 * @param {unknown} cfg
 */
export function apiTokenMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const apiToken = provision.api_token;
  if (!isProxmoxConfigObject(apiToken)) return true;
  return apiToken.enabled !== false && apiToken.enabled !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {string}
 */
export function apiTokenRoleFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return HDC_PROXMOX_API_ROLE;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return HDC_PROXMOX_API_ROLE;
  const apiToken = provision.api_token;
  if (!isProxmoxConfigObject(apiToken)) return HDC_PROXMOX_API_ROLE;
  const role = apiToken.role;
  return typeof role === "string" && role.trim() ? role.trim() : HDC_PROXMOX_API_ROLE;
}

/**
 * @param {unknown} cfg
 * @returns {string[]}
 */
export function apiTokenPrivilegesFromConfig(cfg, profile = pveProfileForMajor(8)) {
  if (!isProxmoxConfigObject(cfg)) return [...profile.apiTokenPrivileges];
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return [...profile.apiTokenPrivileges];
  const apiToken = provision.api_token;
  if (!isProxmoxConfigObject(apiToken)) return [...profile.apiTokenPrivileges];
  const privs = apiToken.privileges;
  if (!Array.isArray(privs) || !privs.length) return [...profile.apiTokenPrivileges];
  return privs.map((p) => String(p).trim()).filter(Boolean);
}

/**
 * @param {string} role
 * @param {string[]} privs
 */
export function pveumEnsureRoleCommands(role, privs) {
  const privArg = shellSingleQuote(privs.join(","));
  const roleQ = shellSingleQuote(role);
  return [
    `if pveum role list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qxF ${roleQ}; then`,
    `pveum role modify ${roleQ} -privs ${privArg}`,
    `else`,
    `pveum role add ${roleQ} -privs ${privArg}`,
    `fi`,
  ];
}

/**
 * @param {string} role
 * @param {string[]} privs
 * @param {string} tokenAcl
 */
export function pveumEnsureRoleAndAclScript(role, privs, tokenAcl) {
  return [...pveumEnsureRoleCommands(role, privs), pveumEnsureTokenAclCommand(tokenAcl, role)].join("; ");
}

/**
 * @param {string} tokenAcl e.g. root@pam!hdc-token
 * @param {string} role
 */
export function pveumEnsureTokenAclCommand(tokenAcl, role) {
  return `pveum acl modify / -token ${shellSingleQuote(tokenAcl)} -role ${shellSingleQuote(role)} -propagate 1`;
}

/**
 * @param {string} userid e.g. homepage@pam
 * @param {string} role
 */
export function pveumEnsureUserAclCommand(userid, role) {
  return `pveum acl modify / -user ${shellSingleQuote(userid)} -role ${shellSingleQuote(role)} -propagate 1`;
}

/**
 * @param {object} opts
 * @param {{ user: string; host: string; id: string }} opts.target
 * @param {string} opts.tokenAcl
 * @param {string} opts.role
 * @param {string[]} opts.privs
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {string | null} opts.password
 * @param {boolean} opts.dryRun
 * @param {(line: string) => void} opts.log
 */
/**
 * @param {object} opts
 * @param {{ mode: "pubkey" | "password"; password: string | null }} opts.sshAuth
 */
function sshBashLcWithAuth(target, remote, opts) {
  const { sshAuth, spawnSync, env, identities, timeoutMs } = opts;
  const mode = sshAuth.mode;
  return sshBashLc(target, remote, {
    spawnSync,
    env,
    mode,
    identities,
    password: mode === "password" ? (sshAuth.password ?? undefined) : undefined,
    timeoutMs,
  });
}

async function ensureTokenAclViaSsh(opts) {
  const { target, tokenAcl, role, privs, spawnSync, env, identities, sshAuth, dryRun, log } = opts;
  const script = pveumEnsureRoleAndAclScript(role, privs, tokenAcl);

  if (dryRun) {
    log(`[${target.id}] would run on ${target.user}@${target.host}: ${script}`);
    return { ok: true };
  }

  if (!sshAuth) return { ok: false, error: "SSH unreachable (no pubkey or password)" };

  const r = sshBashLcWithAuth(target, script, {
    sshAuth,
    spawnSync,
    env,
    identities,
    timeoutMs: 120_000,
  });

  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim() || `ssh exit ${r.status}`;
    return { ok: false, error: err };
  }
  return { ok: true };
}

/**
 * @param {object} opts
 * @param {{ id: string; user: string; host: string }} opts.target
 * @param {string} opts.userid
 * @param {string} opts.tokenid
 * @param {{ mode: "pubkey" | "password"; password: string | null }} opts.sshAuth
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {boolean} opts.dryRun
 * @returns {Promise<{ ok: boolean; tokenValue?: string; error?: string }>}
 */
async function createApiTokenViaSsh(opts) {
  const { target, userid, tokenid, sshAuth, spawnSync, env, identities, dryRun } = opts;
  const script = pveumCreateOrRegenerateTokenScript(userid, tokenid);

  if (dryRun) {
    return { ok: true };
  }

  if (!sshAuth) return { ok: false, error: "SSH unreachable (no pubkey or password)" };

  const r = sshBashLcWithAuth(target, script, {
    sshAuth,
    spawnSync,
    env,
    identities,
    timeoutMs: 120_000,
  });

  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim() || `ssh exit ${r.status}`;
    return { ok: false, error: err };
  }

  const tokenValue = parsePveumTokenSecret(r.stdout, userid, tokenid);
  if (!tokenValue) {
    return { ok: false, error: "could not parse pveum token secret from output" };
  }
  return { ok: true, tokenValue };
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} opts.vault
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {boolean} [opts.dryRun]
 * @param {(q: string, o?: { mask?: boolean }) => Promise<string>} [opts.readLineQuestion]
 * @param {() => import("hdc/cli/lib/host-probe.mjs").HostProbe} [opts.hostProbe]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function runProxmoxApiTokenMaintain(opts) {
  const {
    clumpRoot,
    log,
    warn,
    vault,
    env,
    spawnSync,
    dryRun = false,
    readLineQuestion,
    hostProbe,
  } = opts;
  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";

  if (!existsSync(configPath)) {
    warn(`API token maintain: missing ${configRel} — skip.`);
    return { ok: true };
  }

  /** @type {unknown} */
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    warn(`API token maintain: invalid JSON: ${/** @type {Error} */ (e).message}`);
    return { ok: false };
  }

  if (!apiTokenMaintainEnabledFromConfig(cfg)) {
    log("API token maintain: disabled (provision.api_token.enabled=false) — skip.");
    return { ok: true };
  }

  const role = apiTokenRoleFromConfig(cfg);
  const tokenUserid = apiTokenUseridFromConfig(cfg);
  const hdcTokenId = hdcProxmoxTokenIdFromHostname(hostProbe ? hostProbe().hostname : "host");
  const lxcStorage = lxcTemplateStorageFromConfig(cfg);
  const sshTargets = listProxmoxHypervisorSshTargets(cfg, env);
  const sshById = new Map(sshTargets.map((t) => [t.id, t]));

  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });

  const { publicKeyLines, identities } = discoverLocalSshMaterial();
  if (!publicKeyLines.length && !dryRun) {
    warn("API token maintain: no local SSH public keys — need password in vault for pveum.");
  }

  let ok = true;

  for (const [clusterKey, members] of [...byCluster.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!members?.length) continue;
    const lead = members[0];
    const sshTarget = sshById.get(lead.id);
    if (!sshTarget) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)}: no SSH target for ${JSON.stringify(lead.id)} — skip ACL.`);
      continue;
    }

    let rawToken = await readProxmoxApiTokenRaw({ vault, hostId: lead.id, env });
    const vaultTokenKey = vaultTokenKeyForHost(lead.id);

    if (!rawToken) {
      if (dryRun) {
        log(
          `Cluster ${JSON.stringify(clusterKey)}: dry-run would create API token ${JSON.stringify(hdcTokenId)} on ${JSON.stringify(lead.id)} and store ${JSON.stringify(vaultTokenKey)}.`,
        );
        continue;
      }
      if (!readLineQuestion) {
        ok = false;
        warn(
          `Cluster ${JSON.stringify(clusterKey)}: no API token in vault for ${JSON.stringify(lead.id)} (set ${vaultTokenKey} or enable interactive maintain).`,
        );
        continue;
      }

      log(
        `Cluster ${JSON.stringify(clusterKey)}: creating API token ${JSON.stringify(hdcTokenId)} for ${JSON.stringify(tokenUserid)} on ${JSON.stringify(lead.id)} …`,
      );

      const sshAuth = await resolveProxmoxSshPassword({
        target: sshTarget,
        vault,
        spawnSync,
        env,
        identities,
        readLineQuestion,
        warn,
        dryRun: false,
      });

      if (!sshAuth) {
        ok = false;
        warn(`Cluster ${JSON.stringify(clusterKey)}: SSH unreachable on ${JSON.stringify(lead.id)} — cannot create API token.`);
        continue;
      }

      const created = await createApiTokenViaSsh({
        target: sshTarget,
        userid: tokenUserid,
        tokenid: hdcTokenId,
        sshAuth,
        spawnSync,
        env,
        identities,
        dryRun: false,
      });

      if (!created.ok || !created.tokenValue) {
        ok = false;
        warn(
          `Cluster ${JSON.stringify(clusterKey)}: API token create on ${JSON.stringify(lead.id)} failed: ${created.error ?? "unknown"}`,
        );
        continue;
      }

      await vault.setSecret(vaultTokenKey, created.tokenValue);
      log(`Cluster ${JSON.stringify(clusterKey)}: stored new API token in vault as ${JSON.stringify(vaultTokenKey)}.`);
      rawToken = created.tokenValue;
    }

    const parsed = parsePveApiTokenValue(rawToken);
    if (!parsed) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)}: cannot parse API token for ${JSON.stringify(lead.id)}.`);
      continue;
    }

    const tokenAcl = pveTokenAclId(parsed);
    const configCluster = clusterConfigByKey(cfg, clusterKey);

    /** @type {{ mode: "pubkey" | "password"; password: string | null } | null} */
    let sshAuth = null;
    if (!dryRun) {
      if (readLineQuestion) {
        sshAuth = await resolveProxmoxSshPassword({
          target: sshTarget,
          vault,
          spawnSync,
          env,
          identities,
          readLineQuestion,
          warn,
          dryRun: false,
        });
      } else if (sshReachableWithPubkey(sshTarget, spawnSync, env, identities)) {
        sshAuth = { mode: "pubkey", password: null };
      }
    } else {
      sshAuth = { mode: "pubkey", password: null };
    }

    /** @type {string} */
    let cliVersionOutput = "";
    if (!dryRun && sshAuth) {
      const probe = sshSpawn(sshTarget, ["pve", "version"], {
        spawnSync,
        env,
        mode: sshAuth.mode,
        identities,
        password: sshAuth.mode === "password" ? (sshAuth.password ?? undefined) : undefined,
        timeoutMs: 30_000,
      });
      if (probe.status === 0 && probe.stdout) cliVersionOutput = String(probe.stdout);
    }

    const resolved = await resolveClusterPveProfile({ configCluster, cliVersionOutput });
    const profile = resolved?.profile ?? pveProfileForMajor(8);
    const privs = apiTokenPrivilegesFromConfig(cfg, profile);
    log(
      `Cluster ${JSON.stringify(clusterKey)}: ${resolved ? `PVE ${resolved.version.release} (${profile.id}) — ` : ""}ensure role ${JSON.stringify(role)} and ACL for token ${JSON.stringify(tokenAcl)} via ${JSON.stringify(lead.id)} …`,
    );

    const sshResult = await ensureTokenAclViaSsh({
      target: sshTarget,
      tokenAcl,
      role,
      privs,
      spawnSync,
      env,
      identities,
      sshAuth,
      dryRun,
      log,
    });

    if (!sshResult.ok) {
      ok = false;
      warn(
        `Cluster ${JSON.stringify(clusterKey)}: pveum on ${JSON.stringify(lead.id)} failed: ${sshResult.error ?? "unknown"}`,
      );
      continue;
    }

    if (!dryRun) {
      log(`Cluster ${JSON.stringify(clusterKey)}: ACL applied; verifying API token on ${JSON.stringify(lead.id)} …`);
      const verifyPaths = proxmoxMaintainVerifyPaths(lead.pveNode, lxcStorage);
      try {
        await authorizeProxmoxForHost({
          clumpRoot,
          hostId: lead.id,
          vault,
          configCluster,
          verifyPaths,
        });
        log(`Cluster ${JSON.stringify(clusterKey)}: API token OK (${verifyPaths.length} probe path(s)).`);
      } catch (e) {
        ok = false;
        warn(
          `Cluster ${JSON.stringify(clusterKey)}: token verify failed on ${JSON.stringify(lead.id)}: ${/** @type {Error} */ (e).message || e}`,
        );
      }
    }
  }

  if (ok) log("API token permissions OK on all cluster groups.");
  else log("API token permission ensure failed on one or more clusters — see warnings.");

  return { ok };
}
