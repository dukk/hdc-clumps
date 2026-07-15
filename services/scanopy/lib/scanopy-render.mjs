/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * GitHub raw URL for upstream docker-compose.yml.
 * @param {string} release `latest` or tag like `v0.16.2`
 */
export function composeFileUrl(release) {
  const r = typeof release === "string" && release.trim() ? release.trim() : "latest";
  if (r === "latest" || r === "main") {
    return "https://raw.githubusercontent.com/scanopy/scanopy/refs/heads/main/docker-compose.yml";
  }
  const tag = r.startsWith("v") ? r : `v${r}`;
  return `https://raw.githubusercontent.com/scanopy/scanopy/refs/tags/${encodeURIComponent(tag)}/docker-compose.yml`;
}

/**
 * @param {Record<string, unknown>} scanopy
 * @param {string} postgresPassword
 * @param {string | null} publicUrl
 */
export function renderScanopyEnv(scanopy, postgresPassword, publicUrl) {
  const port =
    typeof scanopy.port === "number" && Number.isFinite(scanopy.port) ? scanopy.port : 60072;
  const logLevel =
    typeof scanopy.log_level === "string" && scanopy.log_level.trim()
      ? scanopy.log_level.trim()
      : "info";
  const url =
    typeof publicUrl === "string" && publicUrl.trim()
      ? publicUrl.trim()
      : `http://127.0.0.1:${port}`;

  const lines = [
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `SCANOPY_PUBLIC_URL=${url}`,
    `SCANOPY_LOG_LEVEL=${logLevel}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Resolve public URL from config and optional detected CT IP.
 * @param {Record<string, unknown>} scanopy
 * @param {string | null} ctIp
 */
export function resolvePublicUrl(scanopy, ctIp) {
  const configured =
    typeof scanopy.public_url === "string" && scanopy.public_url.trim()
      ? scanopy.public_url.trim()
      : null;
  if (configured) return configured;
  const port =
    typeof scanopy.port === "number" && Number.isFinite(scanopy.port) ? scanopy.port : 60072;
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/scanopy";
}
