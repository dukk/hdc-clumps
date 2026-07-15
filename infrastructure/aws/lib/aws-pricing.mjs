import { buildCostEstimate } from "hdc/package/aws-cost-estimate.mjs";

/** @typedef {import("../../../lib/aws-cost-estimate.mjs").CostEstimate} CostEstimate */
/** @typedef {import("./aws-plan.mjs").AwsPlanAction} AwsPlanAction */
/** @typedef {import("./aws-config.mjs").NormalizedAwsConfig} NormalizedAwsConfig */

/** @type {Map<string, { products: unknown[]; fetchedAt: number }>} */
const priceCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

/** AWS region → Price List API location name (subset; fallback uses region id). */
const REGION_LOCATION = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "eu-west-1": "EU (Ireland)",
  "eu-central-1": "EU (Frankfurt)",
};

/**
 * @param {string} region
 */
export function pricingLocationForRegion(region) {
  return REGION_LOCATION[region] ?? region;
}

/**
 * @param {string} serviceCode
 * @param {Record<string, string>} filters
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchPricingProducts(serviceCode, filters, fetchImpl = fetch) {
  const cacheKey = `${serviceCode}:${JSON.stringify(filters)}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.products;
  }

  const filterParams = Object.entries(filters).map(([Field, Value], idx) => ({
    [`Filter.${idx + 1}.Type`]: "TERM_MATCH",
    [`Filter.${idx + 1}.Field`]: Field,
    [`Filter.${idx + 1}.Value`]: Value,
  }));
  /** @type {Record<string, string>} */
  const params = { ServiceCode: serviceCode, FormatVersion: "aws_v1", MaxResults: "100" };
  for (const f of filterParams) Object.assign(params, f);

  const url = new URL("https://api.pricing.us-east-1.amazonaws.com/");
  url.searchParams.set("Action", "GetProducts");
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`AWS Pricing API failed: HTTP ${res.status}`);

  /** @type {unknown[]} */
  const products = [];
  const re = /<member>([\s\S]*?)<\/member>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      products.push(JSON.parse(m[1]));
    } catch {
      // skip malformed
    }
  }
  priceCache.set(cacheKey, { products, fetchedAt: Date.now() });
  return products;
}

/**
 * @param {unknown[]} products
 * @param {string} unit e.g. Hrs, GB-Mo
 */
export function extractOnDemandUnitPrice(products, unit = "Hrs") {
  for (const p of products) {
    if (!p || typeof p !== "object") continue;
    const terms = /** @type {Record<string, unknown>} */ (p).terms;
    if (!terms || typeof terms !== "object") continue;
    const onDemand = /** @type {Record<string, unknown>} */ (terms).OnDemand;
    if (!onDemand || typeof onDemand !== "object") continue;
    for (const term of Object.values(onDemand)) {
      if (!term || typeof term !== "object") continue;
      const priceDims = /** @type {Record<string, unknown>} */ (term).priceDimensions;
      if (!priceDims || typeof priceDims !== "object") continue;
      for (const dim of Object.values(priceDims)) {
        if (!dim || typeof dim !== "object") continue;
        const d = /** @type {Record<string, unknown>} */ (dim);
        if (d.unit !== unit) continue;
        const per = d.pricePerUnit;
        if (!per || typeof per !== "object") continue;
        const usd = /** @type {Record<string, string>} */ (per).USD;
        if (usd) return Number.parseFloat(usd);
      }
    }
  }
  return null;
}

/**
 * @param {AwsPlanAction[]} actions
 * @param {NormalizedAwsConfig} config
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<CostEstimate>}
 */
export async function estimatePlanCost(actions, config, fetchImpl = fetch) {
  const creates = actions.filter((a) => a.action === "create");
  const location = pricingLocationForRegion(config.region);
  /** @type {import("../../../lib/aws-cost-estimate.mjs").CostEstimateLine[]} */
  const lines = [];
  /** @type {string[]} */
  const warnings = [];

  for (const act of creates) {
    const d = act.desired;
    if (!d) continue;
    try {
      if (act.kind === "ec2_instance") {
        const products = await fetchPricingProducts(
          "AmazonEC2",
          {
            location,
            instanceType: d.instance_type,
            tenancy: "Shared",
            operatingSystem: "Linux",
            preInstalledSw: "NA",
            capacitystatus: "Used",
          },
          fetchImpl,
        );
        const hourly = extractOnDemandUnitPrice(products, "Hrs");
        if (hourly != null) {
          lines.push({
            resource_id: d.id,
            service: "EC2",
            monthly_usd: hourly * config.hours_per_month,
            notes: d.instance_type,
          });
        } else {
          warnings.push(`EC2 pricing not found for ${d.instance_type}`);
        }
        const ebsProducts = await fetchPricingProducts(
          "AmazonEC2",
          { location, productFamily: "Storage", volumeApiName: d.root_volume_type ?? "gp3" },
          fetchImpl,
        );
        const gbMonth = extractOnDemandUnitPrice(ebsProducts, "GB-Mo");
        if (gbMonth != null && d.root_volume_gb) {
          lines.push({
            resource_id: `${d.id}-root`,
            service: "EBS",
            monthly_usd: gbMonth * d.root_volume_gb,
            notes: `${d.root_volume_gb} GB ${d.root_volume_type}`,
          });
        }
      } else if (act.kind === "ebs_volume") {
        const ebsProducts = await fetchPricingProducts(
          "AmazonEC2",
          { location, productFamily: "Storage", volumeApiName: d.volume_type ?? "gp3" },
          fetchImpl,
        );
        const gbMonth = extractOnDemandUnitPrice(ebsProducts, "GB-Mo");
        if (gbMonth != null) {
          lines.push({
            resource_id: d.id,
            service: "EBS",
            monthly_usd: gbMonth * d.size_gb,
            notes: `${d.size_gb} GB`,
          });
        }
      } else if (act.kind === "s3_bucket") {
        const s3Products = await fetchPricingProducts(
          "AmazonS3",
          { location, storageClass: "General Purpose", productFamily: "Storage" },
          fetchImpl,
        );
        const gbMonth = extractOnDemandUnitPrice(s3Products, "GB-Mo");
        if (gbMonth != null) {
          lines.push({
            resource_id: d.id,
            service: "S3",
            monthly_usd: gbMonth * (d.estimated_size_gb ?? 10),
            notes: `~${d.estimated_size_gb ?? 10} GB`,
          });
        }
      } else if (act.kind === "ecs_service") {
        const vcpu = d.cpu / 1024;
        const memGb = d.memory / 1024;
        const fargateProducts = await fetchPricingProducts(
          "AmazonECS",
          { location, productFamily: "Compute" },
          fetchImpl,
        );
        const vcpuHour = extractOnDemandUnitPrice(fargateProducts, "vCPU-Hours") ?? 0.04048;
        const gbHour = extractOnDemandUnitPrice(fargateProducts, "GB-Hours") ?? 0.004445;
        const monthly =
          (vcpu * vcpuHour + memGb * gbHour) * config.hours_per_month * (d.desired_count ?? 1);
        lines.push({
          resource_id: d.id,
          service: "ECS Fargate",
          monthly_usd: monthly,
          notes: `${d.cpu} CPU / ${d.memory} MiB × ${d.desired_count}`,
        });
      } else if (act.kind === "vpc" && d.enable_nat_gateway) {
        const natProducts = await fetchPricingProducts(
          "AmazonEC2",
          { location, productFamily: "NAT Gateway" },
          fetchImpl,
        );
        const hourly = extractOnDemandUnitPrice(natProducts, "Hrs") ?? 0.045;
        lines.push({
          resource_id: `${d.id}-nat`,
          service: "NAT Gateway",
          monthly_usd: hourly * config.hours_per_month,
          notes: "on-demand hourly only",
        });
        warnings.push("NAT Gateway data processing charges are not included in this estimate.");
      }
    } catch (err) {
      warnings.push(
        `Pricing lookup failed for ${act.kind}/${act.resource_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (creates.some((a) => a.kind === "ec2_instance")) {
    warnings.push("Public IPv4 address charges may apply for instances in public subnets.");
  }

  return buildCostEstimate(lines, { warnings });
}
