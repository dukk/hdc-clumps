/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} greenbone
 */
export function imageTag(greenbone) {
  const t = typeof greenbone.image_tag === "string" ? greenbone.image_tag.trim() : "";
  return t || "stable";
}

/**
 * @param {Record<string, unknown>} greenbone
 */
export function hostPort(greenbone) {
  const p = typeof greenbone.host_port === "number" ? greenbone.host_port : Number(greenbone.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 3000;
}

/**
 * @param {Record<string, unknown>} greenbone
 */
export function adminUser(greenbone) {
  const user = typeof greenbone.admin_user === "string" ? greenbone.admin_user.trim() : "";
  return user || "admin";
}

/**
 * @param {Record<string, unknown>} greenbone
 */
export function adminPasswordVaultKey(greenbone) {
  const key =
    typeof greenbone.admin_password_vault_key === "string" && greenbone.admin_password_vault_key.trim()
      ? greenbone.admin_password_vault_key.trim()
      : "HDC_GREENBONE_ADMIN_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/greenbone";
}

/**
 * @param {Record<string, unknown>} greenbone
 * @param {string} adminPassword
 */
export function renderGreenboneEnv(greenbone, adminPassword) {
  const lines = [
    "# hdc-generated — docker compose",
    `GREENBONE_IMAGE_TAG=${imageTag(greenbone)}`,
    `GREENBONE_HOST_PORT=${hostPort(greenbone)}`,
    `GREENBONE_ADMIN_USER=${adminUser(greenbone)}`,
    `GREENBONE_ADMIN_PASSWORD=${adminPassword}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} greenbone
 */
export function renderComposeYaml(greenbone) {
  const _cfg = isObject(greenbone) ? greenbone : {};
  return `services:
  greenbone:
    image: greenbone/community-edition:\${GREENBONE_IMAGE_TAG}
    restart: unless-stopped
    ports:
      - "\${GREENBONE_HOST_PORT}:3000"
    env_file:
      - .env
    volumes:
      - greenbone-data:/data

volumes:
  greenbone-data: {}
`;
}
