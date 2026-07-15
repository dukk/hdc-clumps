import { n8nMailEnvLines } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} n8n
 */
export function normalizeImageTag(n8n) {
  const t = typeof n8n.image_tag === "string" ? n8n.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} n8n
 */
export function hostPort(n8n) {
  const p = typeof n8n.host_port === "number" ? n8n.host_port : Number(n8n.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 5678;
}

/**
 * @param {Record<string, unknown>} n8n
 */
export function normalizeTimezone(n8n) {
  const tz = typeof n8n.timezone === "string" ? n8n.timezone.trim() : "";
  return tz || "America/New_York";
}

/**
 * @param {Record<string, unknown>} n8n
 */
export function encryptionKeyVaultKey(n8n) {
  const key =
    typeof n8n.encryption_key_vault_key === "string" && n8n.encryption_key_vault_key.trim()
      ? n8n.encryption_key_vault_key.trim()
      : "HDC_N8N_ENCRYPTION_KEY";
  return key;
}

/**
 * @param {Record<string, unknown>} n8n
 * @returns {URL | null}
 */
export function parsePublicUrl(n8n) {
  const raw = typeof n8n.public_url === "string" ? n8n.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`n8n.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("n8n.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} n8n
 * @param {string | null} ctIp
 */
export function resolveN8nUrlSettings(n8n, ctIp) {
  const parsed = parsePublicUrl(n8n);
  const port = hostPort(n8n);
  if (parsed) {
    const protocol = parsed.protocol.replace(":", "");
    const host = parsed.host;
    const origin = parsed.origin.replace(/\/+$/, "");
    return {
      n8nHost: host,
      n8nProtocol: protocol,
      webhookUrl: `${origin}/`,
      publicUrl: origin,
    };
  }
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) {
    throw new Error("n8n.public_url or CT IP required for N8N_HOST / WEBHOOK_URL");
  }
  const base = `http://${ip}:${port}`;
  return {
    n8nHost: ip,
    n8nProtocol: "http",
    webhookUrl: `${base}/`,
    publicUrl: base,
  };
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/n8n";
}

/**
 * @param {Record<string, unknown>} n8n
 * @param {string} encryptionKey
 * @param {string | null} [ctIp]
 */
export function renderN8nEnv(n8n, encryptionKey, ctIp = null) {
  const tag = normalizeImageTag(n8n);
  const port = hostPort(n8n);
  const tz = normalizeTimezone(n8n);
  const { n8nHost, n8nProtocol, webhookUrl } = resolveN8nUrlSettings(n8n, ctIp);
  const key = String(encryptionKey || "").trim();
  if (!key) {
    throw new Error("N8N_ENCRYPTION_KEY is required");
  }

  const lines = [
    "# hdc-generated — docker compose",
    `N8N_IMAGE_TAG=${tag}`,
    `N8N_HOST_PORT=${port}`,
    `N8N_ENCRYPTION_KEY=${key}`,
    `N8N_HOST=${n8nHost}`,
    `N8N_PORT=5678`,
    `N8N_PROTOCOL=${n8nProtocol}`,
    `WEBHOOK_URL=${webhookUrl}`,
    `TZ=${tz}`,
    `GENERIC_TIMEZONE=${tz}`,
    "N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true",
  ];
  for (const line of n8nMailEnvLines(n8n)) {
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:\${N8N_IMAGE_TAG}
    container_name: n8n
    restart: unless-stopped
    ports:
      - "\${N8N_HOST_PORT}:5678"
    env_file:
      - .env
    volumes:
      - n8n_data:/home/node/.n8n

volumes:
  n8n_data: {}
`;
}

/**
 * @param {Record<string, unknown>} n8n
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(n8n, ctIp = null) {
  return resolveN8nUrlSettings(n8n, ctIp).publicUrl;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} n8n
 */
export function resolveUpstreamUrl(ctIp, n8n) {
  const port = hostPort(n8n);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
