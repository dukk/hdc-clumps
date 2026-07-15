import { createCloudflareClient } from "../../cloudflare/lib/cloudflare-api.mjs";
import { createCloudflareWorkersClient } from "./workers-api.mjs";
import { normalizeCloudflareWorkersConfig, CLUMP_CONFIG_EXAMPLE } from "./workers-config.mjs";
import { createCloudflareVaultAccess, resolveCloudflareToken } from "./vault-deps.mjs";

export { CLUMP_CONFIG_EXAMPLE };

/**
 * @param {unknown} cfgRaw
 */
export async function createWorkersRunContext(cfgRaw) {
  const config = normalizeCloudflareWorkersConfig(cfgRaw);
  const vault = createCloudflareVaultAccess();
  const token = await resolveCloudflareToken(vault);
  const workersApi = createCloudflareWorkersClient({
    token,
    accountId: config.accountId,
    baseUrl: config.apiBase,
  });
  const dnsApi = createCloudflareClient({
    token,
    baseUrl: config.apiBase,
    accountId: config.accountId,
  });
  return { config, vault, token, workersApi, dnsApi };
}

/**
 * @param {ReturnType<typeof createCloudflareVaultAccess>} vault
 * @param {import('./workers-config.mjs').ConfigWorker} worker
 */
export async function readWorkerVaultSecrets(vault, worker) {
  const secrets = await vault.readSecrets({ createIfMissing: false });
  /** @type {Record<string, string>} */
  const out = {};
  for (const s of worker.secrets) {
    const v = secrets?.[s.vault_key];
    if (typeof v === "string") out[s.vault_key] = v;
  }
  return out;
}
