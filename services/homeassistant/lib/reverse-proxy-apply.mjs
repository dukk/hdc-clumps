import { applyHaosReverseProxyConfig } from "./haos-reverse-proxy-config.mjs";

/**
 * @param {string} publicUrl
 * @deprecated HTTP trusted_proxies is UI-owned; kept for tests/compat.
 */
export function publicUrlNeedsReverseProxy(publicUrl) {
  const url = String(publicUrl ?? "").trim();
  return url.startsWith("https://");
}

/**
 * Strip leftover hdc http/trusted_proxies YAML and optionally write notify.apprise.
 * `--skip-reverse-proxy` is a no-op (HTTP YAML is no longer written).
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {ReturnType<import("./deployments.mjs").expandDeployment>} deployment
 * @param {object} opts.auth Proxmox auth (apiBase, authorization, rejectUnauthorized)
 * @param {string} opts.node
 * @param {string} opts.sshUser
 * @param {string} opts.sshHost
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 */
export async function maybeApplyHaosReverseProxyConfig(opts) {
  const { deployment, log = () => {} } = opts;
  const apprise = deployment.homeassistant?.apprise;
  const appriseNotify =
    apprise && apprise.enabled !== false && typeof apprise.configUrl === "string" && apprise.configUrl.trim()
      ? { name: apprise.name || "apprise", configUrl: apprise.configUrl.trim() }
      : null;

  log(
    "HA HTTP/trusted_proxies YAML is no longer written (set trusted proxies in the HA UI). hdc strips leftover reverse-proxy markers.",
  );
  if (appriseNotify) {
    log(`will sync Apprise notify platform (${appriseNotify.configUrl})`);
  }

  const ipHost = deployment.proxmox.qemu.ip.split("/")[0];
  const apiBase = opts.auth.host?.apiBase ?? opts.auth.apiBase;
  const authorization = opts.auth.authorization;
  const rejectUnauthorized = opts.auth.rejectUnauthorized;
  if (!apiBase || !authorization) {
    throw new Error("Proxmox API auth missing for HAOS configuration.yaml update");
  }

  return applyHaosReverseProxyConfig({
    apiBase,
    authorization,
    rejectUnauthorized,
    node: opts.node,
    vmid: deployment.proxmox.qemu.vmid,
    storage: deployment.proxmox.qemu.storage,
    sshUser: opts.sshUser,
    sshHost: opts.sshHost,
    ipHost,
    appriseNotify,
    dryRun: opts.dryRun,
    log,
  });
}
