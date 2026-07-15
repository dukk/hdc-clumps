/**
 * Documented on-demand USD/month estimates for common OCI shapes.
 * @see https://www.oracle.com/cloud/pricing/
 */

/** @type {Record<string, number>} */
export const OCI_VM_MONTHLY_USD = {
  "VM.Standard.E2.1.Micro": 0,
  "VM.Standard.E2.1": 18,
  "VM.Standard.E3.Flex": 12,
  "VM.Standard.E4.Flex": 14,
  "VM.Standard.A1.Flex": 0,
};

/** @type {Record<string, number>} */
export const OCI_CI_MONTHLY_USD = {
  "CI.Standard.E4.Flex": 18,
};

/** @param {string} shape */
export function fallbackVmMonthlyUsd(shape) {
  if (shape in OCI_VM_MONTHLY_USD) return OCI_VM_MONTHLY_USD[shape];
  if (shape.includes("Flex")) return 15;
  return null;
}

/** @param {string} shape */
export function fallbackContainerMonthlyUsd(shape) {
  if (shape in OCI_CI_MONTHLY_USD) return OCI_CI_MONTHLY_USD[shape];
  if (shape.startsWith("CI.")) return 20;
  return null;
}

/**
 * @param {number} diskGb
 */
export function fallbackBootVolumeMonthlyUsd(diskGb) {
  return diskGb * 0.0255;
}

/**
 * @param {number} ocpus
 * @param {number} memoryGb
 */
export function fallbackFlexAdjustUsd(ocpus, memoryGb) {
  return ocpus * 8 + memoryGb * 1.5;
}
