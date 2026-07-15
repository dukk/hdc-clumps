/**
 * Shared helpers to open a MeshCentral API session from vault + config.
 */
import { stderr as errout } from "node:process";

import {
  apiPasswordVaultKey,
  apiUsernameVaultKey,
  connectMeshcentralApi,
  resolveMeshcentralControlUrl,
} from "./meshcentral-api.mjs";
import { configuredDevices, normalizeLiveDevice } from "./meshcentral-devices.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Pick meshcentral block from first deployment (merged defaults).
 * @param {{ meshcentral: Record<string, unknown> }[]} deployments
 */
export function meshcentralFromDeployments(deployments) {
  const d = deployments[0];
  return isObject(d?.meshcentral) ? d.meshcentral : {};
}

/**
 * @param {object} opts
 * @param {import("../../../lib/package-vault-access.mjs").PackageVaultAccess | ReturnType<typeof import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} opts.vault
 * @param {Record<string, unknown>} opts.meshcentral
 * @param {(line: string) => void} [opts.log]
 */
export async function openMeshcentralSession(opts) {
  const log = opts.log ?? ((line) => errout.write(`[hdc] meshcentral: ${line}\n`));
  const meshcentral = opts.meshcentral;
  const usernameKey = apiUsernameVaultKey(meshcentral);
  const passwordKey = apiPasswordVaultKey(meshcentral);
  log(`loading API credentials from vault ${usernameKey} + ${passwordKey}`);
  if (typeof opts.vault.getSecret !== "function") {
    throw new Error("vault access missing getSecret — update hdc CLI");
  }
  const username = await opts.vault.getSecret(usernameKey, { optional: false });
  const password = await opts.vault.getSecret(passwordKey, { optional: false });
  if (!username || !password) {
    throw new Error(`missing MeshCentral API credentials (${usernameKey} / ${passwordKey})`);
  }
  const url = resolveMeshcentralControlUrl(meshcentral);
  const client = await connectMeshcentralApi({
    url,
    username,
    password,
    log,
  });
  return {
    client,
    url,
    usernameKey,
    passwordKey,
    vaultKey: usernameKey,
    username,
  };
}

/**
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {Record<string, unknown>} meshcentral
 */
export async function listNormalizedDevices(client, meshcentral) {
  const raw = await client.listNodes();
  const live = raw.map((n) => normalizeLiveDevice(n));
  const configDevices = configuredDevices(meshcentral);
  return { live, configDevices, raw };
}
