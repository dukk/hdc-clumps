import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { loadClumpConfigFromClumpRoot } from "hdc/package/clump-run-config.mjs";

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
  normalizePveAuthorization,
  parsePveApiTokenValue,
  pveTokenAclId,
} from "./proxmox-deploy-auth.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import { pveJsonRequest } from "./pve-http.mjs";
import { hdcTlsRejectUnauthorized } from "hdc/cli/lib/tls-insecure-env.mjs";
import {
  parsePveumTokenSecret,
  pveumCreateOrRegenerateTokenScript,
  pveumEnsureRoleAndAclScript,
  pveumEnsureTokenAclCommand,
  pveumEnsureUserAclCommand,
} from "./proxmox-api-token-maintain.mjs";
import { pveProfileForMajor, resolveClusterPveProfile } from "./pve-version.mjs";

/** Built-in Proxmox roles that must not be created or modified via pveum role add. */
export const PVE_BUILTIN_ROLES = new Set([
  "Administrator",
  "NoAccess",
  "PVEAdmin",
  "PVEAuditor",
  "PVEDatastoreAdmin",
  "PVEDatastoreUser",
  "PVESysAdmin",
  "PVEVMAdmin",
  "PVEVMUser",
]);

export const DEFAULT_SERVICE_ACCOUNT_ROLE = "PVEAuditor";

/**
 * @typedef {object} ServiceAccountConfig
 * @property {string} id
 * @property {string} userid
 * @property {string} tokenid
 * @property {string} role
 * @property {string} password_vault_key
 * @property {string} token_vault_key
 * @property {string} [comment]
 * @property {string[] | undefined} [privileges]
 * @property {boolean} [enabled]
 */

/**
 * @param {unknown} cfg
 * @returns {ServiceAccountConfig[]}
 */
export function serviceAccountsFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return [];
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return [];
  const accounts = provision.service_accounts;
  if (!Array.isArray(accounts)) return [];

  /** @type {ServiceAccountConfig[]} */
  const out = [];
  for (const raw of accounts) {
    if (!isProxmoxConfigObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const userid = typeof raw.userid === "string" ? raw.userid.trim() : "";
    const tokenid = typeof raw.tokenid === "string" ? raw.tokenid.trim() : "";
    const passwordVaultKey =
      typeof raw.password_vault_key === "string" ? raw.password_vault_key.trim() : "";
    const tokenVaultKey = typeof raw.token_vault_key === "string" ? raw.token_vault_key.trim() : "";
    if (!id || !userid || !tokenid || !passwordVaultKey || !tokenVaultKey) continue;
    if (raw.enabled === false || raw.enabled === 0) continue;

    const role =
      typeof raw.role === "string" && raw.role.trim() ? raw.role.trim() : DEFAULT_SERVICE_ACCOUNT_ROLE;
    const comment = typeof raw.comment === "string" ? raw.comment.trim() : "";
    const privileges = Array.isArray(raw.privileges)
      ? raw.privileges.map((p) => String(p).trim()).filter(Boolean)
      : undefined;

    out.push({
      id,
      userid,
      tokenid,
      role,
      password_vault_key: passwordVaultKey,
      token_vault_key: tokenVaultKey,
      comment: comment || undefined,
      privileges,
    });
  }
  return out;
}

/**
 * @param {string} hostId e.g. pve-a
 * @returns {string} e.g. PVE_A
 */
export function proxmoxHostEnvSlug(hostId) {
  return String(hostId ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function parsePveApiTokenSecret(raw) {
  const t = String(raw ?? "")
    .trim()
    .replace(/^PVEAPIToken=/i, "");
  const eq = t.lastIndexOf("=");
  if (eq < 0) return null;
  const secret = t.slice(eq + 1).trim();
  return secret || null;
}

/**
 * @param {string} raw
 * @returns {string | null} user@realm!tokenid for gethomepage widget username
 */
export function proxmoxWidgetUsernameFromToken(raw) {
  const parsed = parsePveApiTokenValue(raw);
  if (!parsed) return null;
  return `${parsed.userid}!${parsed.tokenid}`;
}

/**
 * @param {string} userid
 * @returns {string}
 */
function localPamUsername(userid) {
  const at = userid.indexOf("@");
  return at > 0 ? userid.slice(0, at) : userid;
}

/**
 * @param {string} userid
 * @param {string} password
 * @param {string} [comment]
 */
export function pveumEnsureUserScript(userid, password, comment = "") {
  const u = shellSingleQuote(userid);
  const p = shellSingleQuote(password);
  const existsCheck = `if pveum user list --output-format json 2>/dev/null | grep -qF ${shellSingleQuote(userid)}; then`;

  if (userid.endsWith("@pam")) {
    const lu = shellSingleQuote(localPamUsername(userid));
    const registerCmd = comment
      ? `pveum user add ${u} --comment ${shellSingleQuote(comment)}`
      : `pveum user add ${u}`;
    return [
      `if ! id ${lu} >/dev/null 2>&1; then`,
      `  useradd -m -s /sbin/nologin ${lu}`,
      "fi",
      `echo ${lu}:${p} | chpasswd`,
      existsCheck,
      "  true",
      "else",
      `  ${registerCmd}`,
      "fi",
    ].join("\n");
  }

  const addCmd = comment
    ? `pveum user add ${u} --password ${p} --comment ${shellSingleQuote(comment)}`
    : `pveum user add ${u} --password ${p}`;
  return [existsCheck, "  true", "else", `  ${addCmd}`, "fi"].join("\n");
}

/**
 * @param {string} userid
 * @param {string} password
 */
export function pveumSetUserPasswordScript(userid, password) {
  const p = shellSingleQuote(password);
  if (userid.endsWith("@pam")) {
    const lu = shellSingleQuote(localPamUsername(userid));
    return `echo ${lu}:${p} | chpasswd`;
  }
  const u = shellSingleQuote(userid);
  return `pveum passwd ${u} --password ${p}`;
}

/**
 * @param {string} userid
 * @param {string} tokenid
 */
export function pveumCreateTokenIfMissingScript(userid, tokenid) {
  const u = shellSingleQuote(userid);
  const t = shellSingleQuote(tokenid);
  const tGrep = shellSingleQuote(tokenid);
  return [
    `if pveum user token list ${u} --output-format json 2>/dev/null | grep -qF ${tGrep}; then`,
    "  echo '{}'",
    "else",
    `  pveum user token add ${u} ${t} --privsep 1 --output-format json`,
    "fi",
  ].join("\n");
}

/**
 * @param {ServiceAccountConfig} account
 * @param {string[]} [privileges]
 */
export function pveumEnsureServiceAccountAclScript(account, privileges = []) {
  const tokenAcl = `${account.userid}!${account.tokenid}`;
  const userAcl = pveumEnsureUserAclCommand(account.userid, account.role);
  let tokenAclScript;
  if (account.privileges?.length || (!PVE_BUILTIN_ROLES.has(account.role) && privileges.length)) {
    const privs = account.privileges?.length ? account.privileges : privileges;
    tokenAclScript = pveumEnsureRoleAndAclScript(account.role, privs, tokenAcl);
  } else {
    tokenAclScript = pveumEnsureTokenAclCommand(tokenAcl, account.role);
  }
  // Privilege-separated tokens need both user and token ACL at / (token-only yields stripped cluster/resources).
  return `${userAcl}; ${tokenAclScript}`;
}

/**
 * Validate cluster/resources payload for gethomepage-style read-only widgets.
 * @param {unknown} body
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function validateServiceAccountClusterResources(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "cluster/resources response is not an object" };
  }
  const data = /** @type {{ data?: unknown }} */ (body).data;
  if (!Array.isArray(data)) {
    return { ok: false, message: "cluster/resources response missing data array" };
  }

  const nodes = data.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      /** @type {{ type?: string; status?: string }} */ (item).type === "node" &&
      /** @type {{ type?: string; status?: string }} */ (item).status === "online",
  );
  const vms = data.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      /** @type {{ type?: string; template?: number }} */ (item).type === "qemu" &&
      /** @type {{ type?: string; template?: number }} */ (item).template === 0,
  );

  if (!nodes.length) {
    return { ok: false, message: "cluster/resources has no online nodes" };
  }
  if (!vms.length) {
    return {
      ok: false,
      message: "cluster/resources has no qemu guests (ensure user + token ACL at / with propagate)",
    };
  }

  const node = /** @type {{ maxmem?: number; maxcpu?: number }} */ (nodes[0]);
  if (node.maxmem == null || node.maxcpu == null) {
    return {
      ok: false,
      message: "cluster/resources node entries lack maxmem/maxcpu (ensure user + token ACL at / with propagate)",
    };
  }

  return { ok: true };
}

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} vault
 * @param {string} key
 */
async function readVaultSecret(vault, key) {
  const data = (await vault.readSecrets({})) ?? {};
  const val = typeof data[key] === "string" ? data[key].trim() : "";
  return val || null;
}

/**
 * @param {object} opts
 * @param {{ user: string; host: string; id: string }} opts.target
 * @param {{ mode: "pubkey" | "password"; password: string | null }} opts.sshAuth
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 * @param {string} opts.remote
 * @param {boolean} opts.dryRun
 */
function runSshScript(opts) {
  const { target, sshAuth, spawnSync, env, identities, remote, dryRun } = opts;
  if (dryRun) return { status: 0, stdout: "", stderr: "" };
  return sshBashLc(target, remote, {
    spawnSync,
    env,
    mode: sshAuth.mode,
    identities,
    password: sshAuth.mode === "password" ? (sshAuth.password ?? undefined) : undefined,
    timeoutMs: 120_000,
  });
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.tokenRaw
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {string} [opts.verifyPath]
 */
async function verifyServiceToken(opts) {
  const { baseUrl, tokenRaw, env: processEnv, verifyPath = "/cluster/resources" } = opts;
  const rejectUnauthorized = hdcTlsRejectUnauthorized(processEnv, "HDC_PROXMOX_TLS_INSECURE");
  const authorization = normalizePveAuthorization(tokenRaw);
  const body = await pveJsonRequest("GET", baseUrl, verifyPath, authorization, rejectUnauthorized, undefined);
  const check = validateServiceAccountClusterResources(body);
  if (!check.ok) {
    throw new Error(check.message);
  }
}

/**
 * Verify a service-account API token against cluster/resources (for consumers that skip SSH ensure).
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.tokenRaw
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {string} [opts.verifyPath]
 */
export async function verifyProxmoxServiceAccountToken(opts) {
  return verifyServiceToken(opts);
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
 * @param {string[]} [opts.filterIds]
 * @param {string[]} [opts.regeneratePasswordIds]
 * @param {string[]} [opts.regenerateTokenIds]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function runProxmoxServiceAccountMaintain(opts) {
  const {
    clumpRoot,
    log,
    warn,
    vault,
    env,
    spawnSync,
    dryRun = false,
    readLineQuestion,
    filterIds = [],
    regeneratePasswordIds = [],
    regenerateTokenIds = [],
  } = opts;

  const configRel = "clumps/infrastructure/proxmox/config.json";

  /** @type {unknown} */
  let cfg;
  /** @type {string} */
  let configPath;
  try {
    const loaded = loadClumpConfigFromClumpRoot(clumpRoot, {
      exampleRel: "clumps/infrastructure/proxmox/config.example.json",
    });
    cfg = loaded.data;
    configPath = loaded.path;
  } catch (e) {
    warn(`Service account maintain: missing or invalid ${configRel} — skip.`);
    return { ok: true };
  }

  let accounts = serviceAccountsFromConfig(cfg);
  if (filterIds.length) {
    const filter = new Set(filterIds.map((id) => id.trim()).filter(Boolean));
    accounts = accounts.filter((a) => filter.has(a.id));
  }
  if (!accounts.length) {
    log("Service account maintain: no matching service_accounts — skip.");
    return { ok: true };
  }

  const sshTargets = listProxmoxHypervisorSshTargets(cfg, env);
  const sshById = new Map(sshTargets.map((t) => [t.id, t]));
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const { publicKeyLines, identities } = discoverLocalSshMaterial();
  if (!publicKeyLines.length && !dryRun) {
    warn("Service account maintain: no local SSH public keys — need password in vault for pveum.");
  }

  let ok = true;

  for (const [clusterKey, members] of [...byCluster.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!members?.length) continue;
    const lead = members[0];
    const sshTarget = sshById.get(lead.id);
    if (!sshTarget) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)}: no SSH target for ${JSON.stringify(lead.id)} — skip service accounts.`);
      continue;
    }

    /** @type {{ mode: "pubkey" | "password"; password: string | null } | null} */
    let sshAuth = null;
    if (dryRun) {
      sshAuth = { mode: "pubkey", password: null };
    } else if (readLineQuestion) {
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

    if (!sshAuth && !dryRun) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)}: SSH unreachable on ${JSON.stringify(lead.id)} — skip service accounts.`);
      continue;
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

    const configCluster = clusterConfigByKey(cfg, clusterKey);
    const resolved = await resolveClusterPveProfile({ configCluster, cliVersionOutput });
    const profile = resolved?.profile ?? pveProfileForMajor(8);

    for (const account of accounts) {
      const regenPassword = regeneratePasswordIds.includes(account.id);
      const regenToken = regenerateTokenIds.includes(account.id);

      log(
        `Cluster ${JSON.stringify(clusterKey)}: service account ${JSON.stringify(account.id)} (${JSON.stringify(account.userid)} / ${JSON.stringify(account.tokenid)}) …`,
      );

      if (dryRun) {
        log(
          `[dry-run] would ensure user, token, and ACL for ${JSON.stringify(account.id)} on ${JSON.stringify(lead.id)}.`,
        );
        continue;
      }

      let password = await readVaultSecret(vault, account.password_vault_key);
      if (!password || regenPassword) {
        password = randomBytes(32).toString("base64url");
        await vault.setSecret(account.password_vault_key, password);
        log(`Stored new password in vault as ${JSON.stringify(account.password_vault_key)}.`);
      }

      const userScript = regenPassword
        ? `${pveumEnsureUserScript(account.userid, password, account.comment ?? "")}; ${pveumSetUserPasswordScript(account.userid, password)}`
        : pveumEnsureUserScript(account.userid, password, account.comment ?? "");

      const userResult = runSshScript({
        target: sshTarget,
        sshAuth: /** @type {{ mode: "pubkey" | "password"; password: string | null }} */ (sshAuth),
        spawnSync,
        env,
        identities,
        remote: userScript,
        dryRun: false,
      });
      if (userResult.status !== 0) {
        ok = false;
        warn(
          `Cluster ${JSON.stringify(clusterKey)}: user ensure for ${JSON.stringify(account.id)} failed: ${(userResult.stderr || userResult.stdout || "").trim() || `exit ${userResult.status}`}`,
        );
        continue;
      }

      let rawToken = await readVaultSecret(vault, account.token_vault_key);
      let tokenCreated = false;

      if (!rawToken || regenToken) {
        const tokenScript = regenToken
          ? pveumCreateOrRegenerateTokenScript(account.userid, account.tokenid)
          : pveumCreateTokenIfMissingScript(account.userid, account.tokenid);

        const tokenResult = runSshScript({
          target: sshTarget,
          sshAuth: /** @type {{ mode: "pubkey" | "password"; password: string | null }} */ (sshAuth),
          spawnSync,
          env,
          identities,
          remote: tokenScript,
          dryRun: false,
        });

        if (tokenResult.status !== 0) {
          ok = false;
          warn(
            `Cluster ${JSON.stringify(clusterKey)}: token create for ${JSON.stringify(account.id)} failed: ${(tokenResult.stderr || tokenResult.stdout || "").trim() || `exit ${tokenResult.status}`}`,
          );
          continue;
        }

        const tokenValue = parsePveumTokenSecret(tokenResult.stdout, account.userid, account.tokenid);
        if (tokenValue) {
          await vault.setSecret(account.token_vault_key, tokenValue);
          log(`Stored new API token in vault as ${JSON.stringify(account.token_vault_key)}.`);
          rawToken = tokenValue;
          tokenCreated = true;
        } else if (!rawToken) {
          ok = false;
          warn(
            `Cluster ${JSON.stringify(clusterKey)}: token ${JSON.stringify(account.tokenid)} exists on cluster but secret missing from vault — run with --regenerate-service-token ${account.id}.`,
          );
          continue;
        }
      }

      const parsed = parsePveApiTokenValue(rawToken);
      if (!parsed) {
        ok = false;
        warn(`Cluster ${JSON.stringify(clusterKey)}: cannot parse token for ${JSON.stringify(account.id)}.`);
        continue;
      }

      const aclScript = pveumEnsureServiceAccountAclScript(account, profile.apiTokenPrivileges);
      const aclResult = runSshScript({
        target: sshTarget,
        sshAuth: /** @type {{ mode: "pubkey" | "password"; password: string | null }} */ (sshAuth),
        spawnSync,
        env,
        identities,
        remote: aclScript,
        dryRun: false,
      });
      if (aclResult.status !== 0) {
        ok = false;
        warn(
          `Cluster ${JSON.stringify(clusterKey)}: ACL for ${JSON.stringify(account.id)} failed: ${(aclResult.stderr || aclResult.stdout || "").trim() || `exit ${aclResult.status}`}`,
        );
        continue;
      }

      if (tokenCreated || regenToken) {
        log(`Cluster ${JSON.stringify(clusterKey)}: verifying token for ${JSON.stringify(account.id)} …`);
      }

      try {
        await verifyServiceToken({ baseUrl: lead.apiBase, tokenRaw: rawToken, env });
        log(`Cluster ${JSON.stringify(clusterKey)}: service account ${JSON.stringify(account.id)} OK.`);
      } catch (e) {
        ok = false;
        warn(
          `Cluster ${JSON.stringify(clusterKey)}: token verify failed for ${JSON.stringify(account.id)}: ${/** @type {Error} */ (e).message || e}`,
        );
      }
    }
  }

  if (ok) log("Service account permissions OK on all cluster groups.");
  else log("Service account ensure failed on one or more clusters — see warnings.");

  return { ok };
}

/**
 * Resolve a service account entry by id from proxmox config object.
 * @param {unknown} cfg
 * @param {string} accountId
 * @returns {ServiceAccountConfig | null}
 */
export function serviceAccountById(cfg, accountId) {
  const id = String(accountId ?? "").trim();
  if (!id) return null;
  return serviceAccountsFromConfig(cfg).find((a) => a.id === id) ?? null;
}

/**
 * Resolve web UI URL for a proxmox host id from config.
 * @param {unknown} cfg
 * @param {string} hostId
 * @returns {string | null}
 */
export function proxmoxHostWebUiFromConfig(cfg, hostId) {
  if (!isProxmoxConfigObject(cfg) || !Array.isArray(cfg.clusters)) return null;
  const want = String(hostId ?? "").trim();
  if (!want) return null;
  for (const cl of cfg.clusters) {
    if (!isProxmoxConfigObject(cl) || !Array.isArray(cl.hosts)) continue;
    for (const h of cl.hosts) {
      if (!isProxmoxConfigObject(h)) continue;
      const id = typeof h.id === "string" ? h.id.trim() : "";
      if (id !== want) continue;
      const webUi = typeof h.web_ui === "string" ? h.web_ui.trim() : "";
      if (webUi) return webUi;
      const ip = typeof h.ip === "string" ? h.ip.trim() : "";
      if (ip) return `https://${ip}:8006`;
      return null;
    }
  }
  return null;
}

export { pveTokenAclId, parsePveApiTokenValue };
