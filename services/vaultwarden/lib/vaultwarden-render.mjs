import { vaultwardenMailEnvLines } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} vaultwarden
 */
export function normalizeDomain(vaultwarden) {
  const d = typeof vaultwarden.domain === "string" ? vaultwarden.domain.trim() : "";
  if (!d) {
    throw new Error("vaultwarden.domain is required (https://… for nginx-waf)");
  }
  if (!/^https:\/\//i.test(d)) {
    throw new Error("vaultwarden.domain must start with https://");
  }
  return d.replace(/\/+$/, "");
}

/**
 * @param {Record<string, unknown>} vaultwarden
 */
export function normalizeImageTag(vaultwarden) {
  const t = typeof vaultwarden.image_tag === "string" ? vaultwarden.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} vaultwarden
 */
export function hostPort(vaultwarden) {
  const p = typeof vaultwarden.host_port === "number" ? vaultwarden.host_port : Number(vaultwarden.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 80;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/vaultwarden";
}

/**
 * @param {Record<string, unknown>} vaultwarden
 */
export function adminTokenVaultKey(vaultwarden) {
  const key =
    typeof vaultwarden.admin_token_vault_key === "string" && vaultwarden.admin_token_vault_key.trim()
      ? vaultwarden.admin_token_vault_key.trim()
      : "HDC_VAULTWARDEN_ADMIN_TOKEN";
  return key;
}

/** @param {string} token */
export function isArgon2PhcAdminToken(token) {
  return /^\$argon2(?:id|i|d)?\$/.test(String(token).trim());
}

/** Docker Compose `.env` treats `$` as interpolation; literal hashes need `$$`. */
export function escapeDockerComposeEnvValue(value) {
  return String(value).replace(/\$/g, "$$$$");
}

/**
 * @param {Record<string, unknown>} vaultwarden
 * @param {string} adminToken Argon2 PHC string for ADMIN_TOKEN (not the plain login password).
 */
export function renderVaultwardenEnv(vaultwarden, adminToken) {
  const domain = normalizeDomain(vaultwarden);
  const tag = normalizeImageTag(vaultwarden);
  const port = hostPort(vaultwarden);
  const signups = vaultwarden.signups_allowed === true;
  const invitations = vaultwarden.invitations_allowed === true;
  const websocket = vaultwarden.websocket_enabled !== false;

  const lines = [
    "# hdc-generated — docker compose",
    `VAULTWARDEN_IMAGE_TAG=${tag}`,
    `VAULTWARDEN_HOST_PORT=${port}`,
    `DOMAIN=${domain}`,
    `ADMIN_TOKEN=${escapeDockerComposeEnvValue(adminToken)}`,
    `SIGNUPS_ALLOWED=${signups ? "true" : "false"}`,
    `INVITATIONS_ALLOWED=${invitations ? "true" : "false"}`,
    `WEBSOCKET_ENABLED=${websocket ? "true" : "false"}`,
    "ROCKET_PORT=80",
  ];
  for (const line of vaultwardenMailEnvLines(vaultwarden)) {
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  vaultwarden:
    image: vaultwarden/server:\${VAULTWARDEN_IMAGE_TAG}
    container_name: vaultwarden
    restart: unless-stopped
    ports:
      - "\${VAULTWARDEN_HOST_PORT}:80"
    volumes:
      - vaultwarden-data:/data
    env_file:
      - .env
    security_opt:
      - apparmor:unconfined

volumes:
  vaultwarden-data: {}
`;
}

/**
 * @param {Record<string, unknown>} vaultwarden
 */
export function resolveWebUrl(vaultwarden) {
  return normalizeDomain(vaultwarden);
}

/**
 * @param {Record<string, unknown>} vaultwarden
 */
export function resolveAdminUrl(vaultwarden) {
  return `${normalizeDomain(vaultwarden)}/admin`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} vaultwarden
 */
export function resolveUpstreamUrl(ctIp, vaultwarden) {
  const port = hostPort(vaultwarden);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
