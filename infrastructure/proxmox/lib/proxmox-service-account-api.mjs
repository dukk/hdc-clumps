import { randomBytes } from "node:crypto";

import { authorizeProxmoxForHost } from "./proxmox-deploy-auth.mjs";
import { parsePveumTokenSecret } from "./proxmox-api-token-maintain.mjs";
import { pveFormBody, pveJsonRequest } from "./pve-http.mjs";
import {
  verifyProxmoxServiceAccountToken,
} from "./proxmox-service-account-maintain.mjs";

/**
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} vault
 * @param {string} key
 */
async function readOptionalVaultSecret(vault, key) {
  const value = (await vault.getSecret(key, { optional: true })).trim();
  return value || null;
}

/**
 * @param {unknown} body
 * @returns {string | null}
 */
function tokenSecretFromApiBody(body, userid, tokenid) {
  return parsePveumTokenSecret(JSON.stringify(body ?? {}), userid, tokenid);
}

/**
 * Regenerate a provision.service_accounts[] token using the hdc operator API token (no SSH).
 * Ensures PVE user (when missing), token, and user+token ACL at /.
 *
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {string} opts.hostId
 * @param {import("./proxmox-service-account-maintain.mjs").ServiceAccountConfig} opts.account
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} opts.vault
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {(line: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.warn]
 * @returns {Promise<{ ok: boolean; tokenRaw?: string }>}
 */
export async function regenerateServiceAccountTokenViaOperatorApi(opts) {
  const { clumpRoot, hostId, account, vault, env, log = () => {}, warn = () => {} } = opts;

  const auth = await authorizeProxmoxForHost({ clumpRoot, hostId, vault, env });
  const { apiBase } = auth.host;
  const { authorization, rejectUnauthorized } = auth;
  const userPath = `/access/users/${encodeURIComponent(account.userid)}`;
  const tokenPath = `${userPath}/token/${encodeURIComponent(account.tokenid)}`;
  const tokenAcl = `${account.userid}!${account.tokenid}`;

  let password = await readOptionalVaultSecret(vault, account.password_vault_key);
  if (!password) {
    password = randomBytes(32).toString("base64url");
  }

  try {
    await pveJsonRequest("GET", apiBase, userPath, authorization, rejectUnauthorized, undefined);
  } catch {
    log(`Creating Proxmox user ${JSON.stringify(account.userid)} via API …`);
    await pveJsonRequest(
      "POST",
      apiBase,
      "/access/users",
      authorization,
      rejectUnauthorized,
      pveFormBody({
        userid: account.userid,
        password,
        enable: 1,
        ...(account.comment ? { comment: account.comment } : {}),
      }),
    );
    await vault.setSecret(account.password_vault_key, password);
  }

  /** @type {string | null} */
  let tokenRaw = null;

  try {
    const body = await pveJsonRequest(
      "PUT",
      apiBase,
      tokenPath,
      authorization,
      rejectUnauthorized,
      pveFormBody({ privsep: 1, regenerate: 1 }),
    );
    tokenRaw = tokenSecretFromApiBody(body, account.userid, account.tokenid);
  } catch (e) {
    warn(`Token regenerate via API failed (${/** @type {Error} */ (e).message || e}); trying create …`);
  }

  if (!tokenRaw) {
    try {
      await pveJsonRequest("DELETE", apiBase, tokenPath, authorization, rejectUnauthorized, undefined);
    } catch {
      /* token may not exist */
    }
    const body = await pveJsonRequest(
      "POST",
      apiBase,
      tokenPath,
      authorization,
      rejectUnauthorized,
      pveFormBody({ privsep: 1 }),
    );
    tokenRaw = tokenSecretFromApiBody(body, account.userid, account.tokenid);
  }

  if (!tokenRaw) {
    warn(`Could not obtain API token secret for service account ${JSON.stringify(account.id)}.`);
    return { ok: false };
  }

  log(`Ensuring ACL for ${JSON.stringify(account.userid)} and ${JSON.stringify(tokenAcl)} …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    "/access/acl",
    authorization,
    rejectUnauthorized,
    pveFormBody({ path: "/", users: account.userid, roles: account.role, propagate: 1 }),
  );
  await pveJsonRequest(
    "PUT",
    apiBase,
    "/access/acl",
    authorization,
    rejectUnauthorized,
    pveFormBody({ path: "/", tokens: tokenAcl, roles: account.role, propagate: 1 }),
  );

  await verifyProxmoxServiceAccountToken({ baseUrl: apiBase, tokenRaw, env });
  await vault.setSecret(account.token_vault_key, tokenRaw);
  log(`Service account ${JSON.stringify(account.id)} token stored as ${JSON.stringify(account.token_vault_key)}.`);

  return { ok: true, tokenRaw };
}
