/**
 * Documented on-demand USD/month estimates when Billing Catalog API is unavailable.
 * @see https://cloud.google.com/compute/all-pricing
 */

/** @type {Record<string, number>} */
export const GCP_VM_MONTHLY_USD = {
  "e2-micro": 6.11,
  "e2-small": 12.21,
  "e2-medium": 24.42,
  "e2-standard-2": 48.84,
  "n2-standard-2": 68.9,
};

/** @param {string} machineType */
export function fallbackVmMonthlyUsd(machineType) {
  const key = machineType.includes("/") ? machineType.split("/").pop() ?? machineType : machineType;
  return GCP_VM_MONTHLY_USD[key] ?? null;
}

/**
 * @param {number} diskGb
 */
export function fallbackDiskMonthlyUsd(diskGb) {
  return diskGb * 0.17;
}

/**
 * @param {number} cpu
 * @param {number} memoryMb
 * @param {number} minInstances
 * @param {number} maxInstances
 */
export function fallbackCloudRunMonthlyUsd(cpu, memoryMb, minInstances, maxInstances) {
  const instances = Math.max(minInstances, 1);
  const cpuHours = cpu * instances * 24 * 30;
  const memGibHours = (memoryMb / 1024) * instances * 24 * 30;
  const cpuCost = cpuHours * 0.000024;
  const memCost = memGibHours * 0.0000025;
  const scaleFactor = maxInstances > minInstances ? 1.25 : 1;
  return (cpuCost + memCost) * scaleFactor;
}
