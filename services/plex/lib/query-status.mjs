import { packageNameFromPlex, portFromPlex, resolveUiUrl } from "./plex-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<import("./deployments.mjs").finalizeDeployment>} deployment
 * @param {string} [host]
 */
export function summarizePlexDeployment(deployment, host = "") {
  const plex = isObject(deployment.plex) ? deployment.plex : {};
  const syn = isObject(deployment.synology) ? deployment.synology : {};
  return {
    system_id: deployment.systemId,
    mode: deployment.mode,
    synology_instance: typeof syn.instance === "string" ? syn.instance : null,
    package_name: packageNameFromPlex(plex),
    port: portFromPlex(plex),
    install_enabled: deployment.install.enabled !== false,
    ui_url: host ? resolveUiUrl(plex, host) : null,
  };
}
