export {
  loadManualSystemSidecar,
  primaryIpFromSystem,
} from "hdc/package/inventory-sidecar.mjs";

/**
 * @param {string} systemId vm-step-ca-a → a
 */
export function instanceLetterFromSystemId(systemId) {
  const m = /^vm-step-ca-([a-z]+)$/.exec(systemId.trim());
  return m ? m[1] : "";
}

/**
 * @param {Record<string, unknown>} stepCa
 * @param {string} instanceLetter
 */
export function caPasswordVaultKey(stepCa, instanceLetter) {
  const base =
    typeof stepCa.password_vault_key === "string" && stepCa.password_vault_key.trim()
      ? stepCa.password_vault_key.trim()
      : "HDC_STEP_CA_PASSWORD";
  if (!instanceLetter) return base;
  const suffix = instanceLetter.toUpperCase().replace(/[^A-Z]/g, "");
  return `${base}_${suffix}`;
}
