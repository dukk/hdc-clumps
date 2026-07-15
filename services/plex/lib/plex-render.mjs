/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} plex
 */
export function packageNameFromPlex(plex) {
  const name =
    isObject(plex) && typeof plex.package_name === "string" && plex.package_name.trim()
      ? plex.package_name.trim()
      : "PlexMediaServer";
  return name;
}

/**
 * @param {Record<string, unknown>} plex
 */
export function portFromPlex(plex) {
  const port = isObject(plex) && typeof plex.port === "number" ? plex.port : Number(plex?.port);
  return Number.isFinite(port) && port > 0 ? port : 32400;
}

/**
 * @param {Record<string, unknown>} plex
 * @param {string} host
 */
export function resolveUiUrl(plex, host) {
  const publicUrl =
    isObject(plex) && typeof plex.public_url === "string" && plex.public_url.trim()
      ? plex.public_url.trim()
      : "";
  if (publicUrl) {
    return publicUrl.endsWith("/web") ? publicUrl : `${publicUrl.replace(/\/$/, "")}/web`;
  }
  const port = portFromPlex(plex);
  const h = typeof host === "string" && host.trim() ? host.trim() : "127.0.0.1";
  return `http://${h}:${port}/web`;
}
