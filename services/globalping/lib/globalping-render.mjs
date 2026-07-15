/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const DEFAULT_ADOPTION_TOKEN_VAULT_KEY = "HDC_GLOBALPING_ADOPTION_TOKEN";

/**
 * @param {Record<string, unknown>} globalping
 */
export function normalizeImage(globalping) {
  const img = typeof globalping.image === "string" ? globalping.image.trim() : "";
  return img || "globalping/globalping-probe:latest";
}

/**
 * @param {Record<string, unknown>} globalping
 */
export function adoptionTokenVaultKey(globalping) {
  const key =
    typeof globalping.adoption_token_vault_key === "string"
      ? globalping.adoption_token_vault_key.trim()
      : "";
  return key || DEFAULT_ADOPTION_TOKEN_VAULT_KEY;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/globalping";
}

/**
 * @param {string | null | undefined} adoptionToken
 */
export function renderEnvFile(adoptionToken) {
  const token =
    typeof adoptionToken === "string" && adoptionToken.trim() ? adoptionToken.trim() : "";
  if (!token) {
    throw new Error("GP_ADOPTION_TOKEN is required — set HDC_GLOBALPING_ADOPTION_TOKEN in vault");
  }
  return ["# hdc-generated — docker compose env", `GP_ADOPTION_TOKEN=${token}`].join("\n");
}

/**
 * @param {Record<string, unknown>} globalping
 */
export function renderComposeYaml(globalping) {
  const image = normalizeImage(globalping);
  return `services:
  globalping-probe:
    image: ${image}
    container_name: globalping-probe
    network_mode: host
    restart: unless-stopped
    logging:
      driver: local
    env_file:
      - .env
`;
}
