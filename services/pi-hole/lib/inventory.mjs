import { flagGet } from "hdc/package/parse-argv-flags.mjs";

export {
  loadManualSystemSidecar,
  primaryIpFromSystem,
} from "hdc/package/inventory-sidecar.mjs";

/**
 * @param {Record<string, unknown>} pihole
 * @param {string} instanceLetter
 */
export function apiTokenVaultKey(pihole, instanceLetter) {
  const perInstance =
    typeof pihole.api_token_vault_key === "string" && pihole.api_token_vault_key.trim()
      ? pihole.api_token_vault_key.trim()
      : "HDC_PIHOLE_API_TOKEN";
  if (!instanceLetter) return perInstance;
  const suffix = instanceLetter.toUpperCase().replace(/[^A-Z]/g, "");
  return `${perInstance}_${suffix}`;
}

/**
 * @param {Record<string, unknown>} pihole
 */
export function webPasswordVaultKey(pihole) {
  return typeof pihole.webpassword_vault_key === "string" && pihole.webpassword_vault_key.trim()
    ? pihole.webpassword_vault_key.trim()
    : "HDC_PIHOLE_WEBPASSWORD";
}

/**
 * Admin web password from config or CLI (vault not used when webpassword is set in config).
 * @param {Record<string, unknown>} pihole
 * @param {Record<string, string>} flags
 */
export function resolvePiHoleWebPassword(pihole, flags) {
  const fromFlag = flagGet(flags, "webpassword");
  if (fromFlag) return fromFlag.trim();
  const fromCfg = typeof pihole.webpassword === "string" ? pihole.webpassword.trim() : "";
  if (!fromCfg) {
    throw new Error(
      "pihole.webpassword required in config (set defaults.pihole.webpassword or pass --webpassword after --)",
    );
  }
  return fromCfg;
}
