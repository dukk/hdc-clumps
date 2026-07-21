import { normalizeAuthMode } from "hdc/apps/hdc-web-server/lib/web-config.mjs";

/**
 * Render hdc-web-server meta `web-config.json` from hdc_agents config.
 *
 * @param {Record<string, unknown>} hdcAgents
 */
export function renderWebConfigJson(hdcAgents) {
  const web =
    hdcAgents.web && typeof hdcAgents.web === "object"
      ? /** @type {Record<string, unknown>} */ (hdcAgents.web)
      : {};
  const authMode = normalizeAuthMode(web.auth_mode);
  const adminUsername =
    typeof web.admin_username === "string" && web.admin_username.trim()
      ? web.admin_username.trim()
      : "admin";

  return `${JSON.stringify(
    {
      auth: {
        mode: authMode,
        htpasswd_file: ".htpasswd.enc",
        admin_username: adminUsername,
      },
      allowed_verbs: ["query", "maintain"],
      max_concurrent_jobs: 1,
    },
    null,
    2,
  )}\n`;
}
