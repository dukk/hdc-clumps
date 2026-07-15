/**
 * Azure Retail Prices API (public, no auth).
 * @see https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
 */

const RETAIL_BASE = "https://prices.azure.com/api/retail/prices";

/** @type {Map<string, Promise<unknown[]>>} */
const pageCache = new Map();

/**
 * @param {string} filter OData filter
 * @param {{ fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchRetailPrices(filter, opts = {}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const cacheKey = filter;
  let pending = pageCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      /** @type {Record<string, unknown>[]} */
      const items = [];
      let url = `${RETAIL_BASE}?$filter=${encodeURIComponent(filter)}`;
      for (let page = 0; page < 20 && url; page++) {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
        const text = await res.text();
        if (!res.ok) throw new Error(`Azure Retail Prices API HTTP ${res.status}`);
        /** @type {{ Items?: unknown[]; NextPageLink?: string }} */
        let json = {};
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("Azure Retail Prices API returned non-JSON");
        }
        for (const row of json.Items ?? []) {
          if (row && typeof row === "object") items.push(/** @type {Record<string, unknown>} */ (row));
        }
        url = typeof json.NextPageLink === "string" ? json.NextPageLink : "";
      }
      return items;
    })();
    pageCache.set(cacheKey, pending);
  }
  return /** @type {Promise<Record<string, unknown>[]>} */ (pending);
}

/**
 * Pick lowest Pay-as-you-go hourly price for a SKU in a region.
 * @param {Record<string, unknown>[]} items
 * @param {string} [unitOfMeasure]
 */
export function pickHourlyUnitPrice(items, unitOfMeasure = "1 Hour") {
  let best = null;
  for (const row of items) {
    const unit = String(row.unitOfMeasure ?? "");
    if (unitOfMeasure && unit !== unitOfMeasure) continue;
    const price = Number(row.retailPrice ?? row.unitPrice);
    if (!Number.isFinite(price) || price < 0) continue;
    const type = String(row.type ?? "");
    if (type && type !== "Consumption") continue;
    if (best === null || price < best) best = price;
  }
  return best;
}

/**
 * @param {string} region
 * @param {string} armSkuName
 * @param {{ fetchFn?: typeof fetch }} [opts]
 */
export async function hourlyVmPrice(region, armSkuName, opts = {}) {
  const filter = [
    "serviceName eq 'Virtual Machines'",
    `armRegionName eq '${region.replace(/'/g, "''")}'`,
    `armSkuName eq '${armSkuName.replace(/'/g, "''")}'`,
  ].join(" and ");
  const items = await fetchRetailPrices(filter, opts);
  return pickHourlyUnitPrice(items, "1 Hour");
}

/**
 * @param {string} region
 * @param {number} diskGb
 * @param {{ fetchFn?: typeof fetch }} [opts]
 */
export async function monthlyManagedDiskPrice(region, diskGb, opts = {}) {
  const filter = [
    "serviceName eq 'Storage'",
    `armRegionName eq '${region.replace(/'/g, "''")}'`,
    "contains(productName,'Premium SSD Managed Disks')",
    "meterName eq 'P6 LRS Disk'",
  ].join(" and ");
  const items = await fetchRetailPrices(filter, opts);
  const perMonth = pickHourlyUnitPrice(items, "1 Month");
  if (perMonth === null) {
    const perGbFilter = [
      "serviceName eq 'Storage'",
      `armRegionName eq '${region.replace(/'/g, "''")}'`,
      "contains(productName,'Premium SSD Managed Disks')",
      "contains(meterName,'Disk')",
    ].join(" and ");
    const gbItems = await fetchRetailPrices(perGbFilter, opts);
    const perGbMonth = pickHourlyUnitPrice(gbItems, "1 GB/Month");
    if (perGbMonth === null) return null;
    return perGbMonth * diskGb;
  }
  return perMonth;
}

/**
 * @param {string} region
 * @param {number} cpu
 * @param {number} memoryGb
 * @param {{ fetchFn?: typeof fetch }} [opts]
 */
export async function monthlyAciPrice(region, cpu, memoryGb, opts = {}) {
  const filter = [
    "serviceName eq 'Container Instances'",
    `armRegionName eq '${region.replace(/'/g, "''")}'`,
  ].join(" and ");
  const items = await fetchRetailPrices(filter, opts);
  const vcpuSecond = items.find((r) => String(r.unitOfMeasure) === "1 vCPU Second");
  const gibSecond = items.find((r) => String(r.unitOfMeasure) === "1 GiB Second");
  const vcpuRate = Number(vcpuSecond?.retailPrice ?? vcpuSecond?.unitPrice);
  const gibRate = Number(gibSecond?.retailPrice ?? gibSecond?.unitPrice);
  if (!Number.isFinite(vcpuRate) || !Number.isFinite(gibRate)) return null;
  const secondsPerMonth = 30 * 24 * 3600;
  return (vcpuRate * cpu + gibRate * memoryGb) * secondsPerMonth;
}

/** Reset cache (tests). */
export function resetRetailPriceCache() {
  pageCache.clear();
}
