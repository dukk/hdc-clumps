import { stderr as errout } from "node:process";

import { createImmichApiClient, resolveImmichApiBaseUrl } from "./immich-api.mjs";
import { resolveImmichApiKey } from "./immich-vault-deps.mjs";
import {
  mergeSystemConfigForMaintain,
  smtpSummaryFromSystemConfig,
  systemConfigChanged,
} from "./immich-admin-config.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<import("./vault-deps.mjs").createImmichVaultAccess>} opts.vault
 * @param {Record<string, unknown>} opts.immich
 * @param {string | null} [opts.sshHost]
 * @param {string | null} [opts.testEmail]
 * @param {(line: string) => void} [opts.log]
 */
export async function syncImmichAdminConfig(opts) {
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const apiKey = await resolveImmichApiKey(opts.vault, opts.immich, { required: true });
  const apiBase = resolveImmichApiBaseUrl(opts.immich, opts.sshHost);
  if (!apiBase) {
    throw new Error("immich.public_url or configure.ssh.host required for admin API");
  }

  const api = createImmichApiClient({ apiBase, apiKey });
  log(`[hdc] immich admin: GET system-config from ${apiBase} …`);
  const live = await api.getSystemConfig();
  const merged = mergeSystemConfigForMaintain(live, opts.immich);
  const changed = systemConfigChanged(live, merged);

  if (changed) {
    log(`[hdc] immich admin: PUT system-config …`);
    await api.putSystemConfig(merged);
  } else {
    log(`[hdc] immich admin: system-config already matches — skip PUT`);
  }

  const smtp = smtpSummaryFromSystemConfig(merged);
  /** @type {Record<string, unknown>} */
  const result = {
    ok: true,
    api_base: apiBase,
    changed,
    smtp_enabled: smtp.enabled,
    smtp_summary: smtp,
  };

  if (opts.testEmail && smtp.enabled) {
    const notifications =
      merged && typeof merged === "object" && merged.notifications
        ? merged.notifications
        : null;
    const smtpDto =
      notifications && typeof notifications === "object" && notifications.smtp
        ? notifications.smtp
        : null;
    if (smtpDto && typeof smtpDto === "object") {
      log(`[hdc] immich admin: sending test email (Immich delivers to API key admin) …`);
      const testRes = await api.sendTestEmail(smtpDto);
      result.test_email = { ok: true, note: opts.testEmail ?? null, response: testRes };
    }
  }

  return result;
}

/**
 * @param {object} opts
 * @param {ReturnType<import("./vault-deps.mjs").createImmichVaultAccess>} opts.vault
 * @param {Record<string, unknown>} opts.immich
 * @param {string | null} [opts.sshHost]
 * @param {(line: string) => void} [opts.log]
 */
export async function fetchImmichAdminState(opts) {
  const apiKey = await resolveImmichApiKey(opts.vault, opts.immich, { required: true });
  const apiBase = resolveImmichApiBaseUrl(opts.immich, opts.sshHost);
  if (!apiBase) {
    throw new Error("immich.public_url or configure.ssh.host required for admin API");
  }

  const api = createImmichApiClient({ apiBase, apiKey });
  const live = await api.getSystemConfig();
  return {
    api_base: apiBase,
    live,
    smtp_summary: smtpSummaryFromSystemConfig(live),
  };
}
