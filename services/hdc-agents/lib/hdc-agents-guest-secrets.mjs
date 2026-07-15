/**
 * Build compose/.env contents and schedules.json for hdc-agents guest.
 */
import { randomBytes } from "node:crypto";

import { mcpApiKeyVaultKey } from "../../../../apps/hdc-mcp-server/lib/api-keys.mjs";
import { schedulesFromConfig } from "../../../../apps/hdc-agent-server/lib/scheduler-catalog.mjs";
import { ensureMcpApiKeysForAgents, mcpApiKeyRoles } from "./mcp-api-keys-ensure.mjs";
/**
 * @param {{
 *   vault: { unlock: Function, getSecret: Function, setSecret: Function },
 *   privateRoot: string,
 *   hdcAgents: Record<string, unknown>,
 *   rotateMcpKeys?: boolean,
 * }} opts
 */
export async function prepareAgentsGuestSecrets(opts) {
  const { vault, privateRoot, hdcAgents, rotateMcpKeys = false } = opts;
  const secretsByRole = await ensureMcpApiKeysForAgents({
    vault,
    privateRoot,
    hdcAgents,
    rotate: rotateMcpKeys,
  });

  /** @type {string[]} */
  const envLines = [
    "HDC_SECRET_BACKEND=vaultwarden",
    "HDC_PRIVATE_ROOT=/opt/hdc-private",
    "HDC_ROOT=/opt/hdc",
    "HDC_AGENTS_META_ROOT=/opt/hdc-agents-meta",
  ];

  for (const role of mcpApiKeyRoles(hdcAgents)) {
    const vk = mcpApiKeyVaultKey(role);
    const secret = secretsByRole[role] || "";
    envLines.push(`${vk}=${secret}`);
  }

  // Web UI: session + API token (mint); OIDC client secret from Keycloak maintain
  for (const [key, gen] of [
    ["HDC_WEB_UI_SESSION_SECRET", () => randomBytes(32).toString("base64url")],
    ["HDC_WEB_API_TOKEN", () => randomBytes(32).toString("base64url")],
  ]) {
    let val = String((await vault.getSecret(key, { optional: true })) ?? "").trim();
    if (!val) {
      const legacy = key.replace("HDC_WEB_", "HDC_HDC_RUNNER_");
      val = String((await vault.getSecret(legacy, { optional: true })) ?? "").trim();
    }
    if (!val) {
      val = /** @type {() => string} */ (gen)();
      await vault.setSecret(key, val);
    }
    envLines.push(`${key}=${val}`);
  }

  const oidc =
    hdcAgents.oidc && typeof hdcAgents.oidc === "object"
      ? /** @type {Record<string, unknown>} */ (hdcAgents.oidc)
      : {};
  const oidcIssuer =
    typeof oidc.issuer === "string" && oidc.issuer.trim()
      ? oidc.issuer.trim().replace(/\/+$/, "")
      : "https://keycloak.hdc.dukk.org/realms/dukk-sso";
  const oidcClientId =
    typeof oidc.client_id === "string" && oidc.client_id.trim()
      ? oidc.client_id.trim()
      : "hdc-web";
  envLines.push(`HDC_WEB_OIDC_ISSUER=${oidcIssuer}`);
  envLines.push(`HDC_WEB_OIDC_CLIENT_ID=${oidcClientId}`);

  const publicUrl =
    typeof hdcAgents.public_url === "string" && hdcAgents.public_url.trim()
      ? hdcAgents.public_url.trim().replace(/\/+$/, "")
      : "";
  if (publicUrl) {
    envLines.push(`HDC_WEB_PUBLIC_URL=${publicUrl}`);
  }

  const oidcSecretKey =
    typeof oidc.client_secret_vault_key === "string" && oidc.client_secret_vault_key.trim()
      ? oidc.client_secret_vault_key.trim()
      : "HDC_WEB_OIDC_CLIENT_SECRET";
  const oidcSecret = String((await vault.getSecret(oidcSecretKey, { optional: true })) ?? "").trim();
  if (oidcSecret) {
    envLines.push(`HDC_WEB_OIDC_CLIENT_SECRET=${oidcSecret}`);
  }

  const mail = hdcAgents.mail && typeof hdcAgents.mail === "object" ? hdcAgents.mail : {};
  const mailbox =
    hdcAgents.mailbox && typeof hdcAgents.mailbox === "object"
      ? /** @type {Record<string, unknown>} */ (hdcAgents.mailbox)
      : {};
  const discord =
    hdcAgents.discord && typeof hdcAgents.discord === "object"
      ? /** @type {Record<string, unknown>} */ (hdcAgents.discord)
      : {};

  const mailboxPassKey =
    typeof mailbox.password_vault_key === "string" && mailbox.password_vault_key.trim()
      ? mailbox.password_vault_key.trim()
      : "HDC_MAILCOW_MAILBOX_MANAGER_HDC_DUKK_ORG_PASSWORD";
  let mailboxPass = String((await vault.getSecret(mailboxPassKey, { optional: true })) ?? "").trim();
  if (!mailboxPass) {
    mailboxPass = randomBytes(24).toString("base64url");
    await vault.setSecret(mailboxPassKey, mailboxPass);
  }
  envLines.push(`HDC_MANAGER_MAILBOX_PASSWORD=${mailboxPass}`);

  const roleFrom =
    mail.role_from && typeof mail.role_from === "object"
      ? /** @type {Record<string, unknown>} */ (mail.role_from)
      : {};
  for (const [role, addr] of Object.entries(roleFrom)) {
    if (typeof addr === "string" && addr.trim()) {
      envLines.push(`HDC_AGENT_MAIL_FROM_${role.replace(/-/g, "_").toUpperCase()}=${addr.trim()}`);
    }
  }

  const agentsWebhookVaultKey =
    typeof discord.webhook_vault_key === "string" && discord.webhook_vault_key.trim()
      ? discord.webhook_vault_key.trim()
      : "HDC_AGENTS_DISCORD_WEBHOOK_URL";

  // Optional Discord + LiteLLM pass-through when present in vault.
  // Keep OPS webhook for CLI child processes; agents webhook for scheduler/MCP.
  const passThroughKeys = [
    ...new Set([
      "HDC_OPS_DISCORD_WEBHOOK_URL",
      agentsWebhookVaultKey,
      "HDC_LITELLM_MASTER_KEY",
      ...mcpApiKeyRoles(hdcAgents)
        .filter((r) => r !== "hdc-scheduler")
        .map((r) => `HDC_AGENT_LITELLM_KEY_${r.replace(/-/g, "_").toUpperCase()}`),
    ]),
  ];
  for (const key of passThroughKeys) {
    const val = String((await vault.getSecret(key, { optional: true })) ?? "").trim();
    if (val) envLines.push(`${key}=${val}`);
  }

  const applicationId =
    typeof discord.application_id === "string" && discord.application_id.trim()
      ? discord.application_id.trim()
      : "";
  const publicKey =
    typeof discord.public_key === "string" && discord.public_key.trim()
      ? discord.public_key.trim()
      : "";
  const channelId =
    typeof discord.channel_id === "string" && discord.channel_id.trim()
      ? discord.channel_id.trim()
      : "";
  if (applicationId) envLines.push(`HDC_OPS_DISCORD_APPLICATION_ID=${applicationId}`);
  if (publicKey) envLines.push(`HDC_OPS_DISCORD_PUBLIC_KEY=${publicKey}`);
  if (channelId) envLines.push(`HDC_OPS_DISCORD_CHANNEL_ID=${channelId}`);

  const botTokenKey =
    typeof discord.bot_token_vault_key === "string" && discord.bot_token_vault_key.trim()
      ? discord.bot_token_vault_key.trim()
      : "HDC_OPS_DISCORD_BOT_TOKEN";
  const botToken = String((await vault.getSecret(botTokenKey, { optional: true })) ?? "").trim();
  if (botToken) envLines.push(`HDC_OPS_DISCORD_BOT_TOKEN=${botToken}`);

  /** @type {Record<string, unknown>} */
  const discordScheduleDefaults = {
    enabled: discord.enabled,
    title_prefix: discord.title_prefix,
    on_failure_only: discord.on_failure_only,
    webhook_vault_key: agentsWebhookVaultKey,
  };
  const schedules = schedulesFromConfig(hdcAgents).map((s) => ({
    ...s,
    mail: { ...mail, ...(s.mail && typeof s.mail === "object" ? s.mail : {}) },
    discord: {
      ...discordScheduleDefaults,
      ...(s.discord && typeof s.discord === "object" ? s.discord : {}),
    },
  }));

  /** @type {Record<string, unknown>} */
  const mailboxJson = {
    enabled: mailbox.enabled !== false,
    host:
      typeof mailbox.host === "string" && mailbox.host.trim()
        ? mailbox.host.trim()
        : "mailcow-a.hdc.dukk.org",
    port: typeof mailbox.port === "number" ? mailbox.port : 993,
    user:
      typeof mailbox.user === "string" && mailbox.user.trim()
        ? mailbox.user.trim()
        : "manager@hdc.dukk.org",
    password_env: "HDC_MANAGER_MAILBOX_PASSWORD",
    password_vault_key: mailboxPassKey,
    tls_reject_unauthorized: mailbox.tls_reject_unauthorized === true,
    folders: Array.isArray(mailbox.folders) && mailbox.folders.length
      ? mailbox.folders.map((f) => String(f).trim()).filter(Boolean)
      : ["INBOX", "Junk"],
    trusted_senders: Array.isArray(mailbox.trusted_senders)
      ? mailbox.trusted_senders
      : ["dukk@dukk.org"],
    wazuh_alert_level_min:
      typeof mailbox.wazuh_alert_level_min === "number" ? mailbox.wazuh_alert_level_min : 10,
    block_days: typeof mailbox.block_days === "number" ? mailbox.block_days : 30,
  };

  return {
    composeEnv: `${envLines.join("\n")}\n`,
    schedulesJson: `${JSON.stringify({ schedules }, null, 2)}\n`,
    mailboxJson: `${JSON.stringify(mailboxJson, null, 2)}\n`,
  };
}
