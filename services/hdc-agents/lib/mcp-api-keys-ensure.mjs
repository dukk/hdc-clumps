/**
 * Ensure per-role HDC_MCP_API_KEY_* secrets exist in vault and hash registry.
 */
import { stderr as errout } from "node:process";

import {
  mintMcpApiKeySecret,
  mcpApiKeyVaultKey,
  registerMcpApiKeyHash,
} from "../../../../apps/hdc-mcp-server/lib/api-keys.mjs";
import { AGENT_ROSTER, enabledAgents } from "./hdc-agents-render.mjs";

/** Roles that need MCP API keys (roster + scheduler). */
export function mcpApiKeyRoles(hdcAgents) {
  const roles = enabledAgents(hdcAgents).map((a) => a.role);
  if (!roles.includes("hdc-scheduler")) roles.push("hdc-scheduler");
  return roles;
}

/**
 * @param {{
 *   vault: { unlock: (o?: object) => Promise<void>, getSecret: Function, setSecret: Function },
 *   privateRoot: string,
 *   hdcAgents?: Record<string, unknown>,
 *   rotate?: boolean,
 * }} opts
 * @returns {Promise<Record<string, string>>} role → plaintext secret (for compose env file)
 */
export async function ensureMcpApiKeysForAgents(opts) {
  const { vault, privateRoot, rotate = false } = opts;
  const hdcAgents = opts.hdcAgents ?? {};
  await vault.unlock({});
  /** @type {Record<string, string>} */
  const secretsByRole = {};
  for (const role of mcpApiKeyRoles(hdcAgents)) {
    const vaultKey = mcpApiKeyVaultKey(role);
    let secret = "";
    if (!rotate) {
      const existing = await vault.getSecret(vaultKey, { optional: true });
      secret = typeof existing === "string" ? existing.trim() : "";
    }
    if (!secret) {
      secret = mintMcpApiKeySecret();
      await vault.setSecret(vaultKey, secret);
      errout.write(`[hdc] hdc-agents: minted MCP API key for ${role} → vault ${vaultKey}\n`);
    } else {
      errout.write(`[hdc] hdc-agents: MCP API key for ${role} loaded from vault ${vaultKey}\n`);
    }
    registerMcpApiKeyHash(privateRoot, { role, secret, label: role });
    secretsByRole[role] = secret;
  }
  void AGENT_ROSTER;
  return secretsByRole;
}
