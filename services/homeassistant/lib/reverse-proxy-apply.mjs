import { applyHaosReverseProxyConfig } from "./haos-reverse-proxy-config.mjs";
import { resolveNginxWafTrustedProxies } from "./resolve-nginx-waf-proxies.mjs";

/**
 * @param {string} publicUrl
 */
export function publicUrlNeedsReverseProxy(publicUrl) {
  const url = String(publicUrl ?? "").trim();
  return url.startsWith("https://");
}

/**
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
  const publicUrl = deployment.homeassistant.publicUrl;
  if (!publicUrlNeedsReverseProxy(publicUrl)) {
    return { skipped: true, reason: "no_https_public_url" };
  }

  const trustedProxies = resolveNginxWafTrustedProxies(opts.repoRoot, {
    overrideIps: deployment.homeassistant.trustedProxies,
  });
  if (!trustedProxies.length) {
    log(
      "no nginx-waf trusted_proxies resolved (inventory vm-nginx-waf-* or homeassistant.trusted_proxies) — skipping reverse-proxy config",
    );
    return { skipped: true, reason: "no_trusted_proxies" };
  }

  const ipHost = deployment.proxmox.qemu.ip.split("/")[0];
  const apiBase = opts.auth.host?.apiBase ?? opts.auth.apiBase;
  const authorization = opts.auth.authorization;
  const rejectUnauthorized = opts.auth.rejectUnauthorized;
  if (!apiBase || !authorization) {
    throw new Error("Proxmox API auth missing for reverse-proxy config");
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
    trustedProxies,
    externalUrl: publicUrl,
    dryRun: opts.dryRun,
    log,
  });
}
