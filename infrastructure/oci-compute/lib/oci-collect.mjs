import {
  HDC_MANAGED_TAG_KEY,
  HDC_MANAGED_TAG_VALUE,
  HDC_RESOURCE_ID_TAG_KEY,
  hdcFreeformTags,
} from "./oci-config.mjs";
import { iaasHost, ociListItems } from "./oci-api.mjs";

/** @typedef {import("./oci-api.mjs").OciClient} OciClient */
/** @typedef {import("./oci-config.mjs").NormalizedOciComputeConfig} NormalizedOciComputeConfig */
/** @typedef {import("./oci-config.mjs").NormalizedVcn} NormalizedVcn */
/** @typedef {import("./oci-config.mjs").NormalizedSubnet} NormalizedSubnet */
/** @typedef {import("./oci-config.mjs").NormalizedNsg} NormalizedNsg */

/**
 * @param {Record<string, string>} freeformTags
 */
export function resourceIdFromTags(freeformTags) {
  if (!freeformTags || freeformTags[HDC_MANAGED_TAG_KEY] !== HDC_MANAGED_TAG_VALUE) return null;
  return freeformTags[HDC_RESOURCE_ID_TAG_KEY] ?? null;
}

/**
 * @param {OciClient} client
 * @param {NormalizedOciComputeConfig} config
 */
export async function collectOciLiveState(client, config) {
  const host = iaasHost(client.region);
  const compartmentId = config.compartment_id;

  /** @type {Record<string, unknown>[]} */
  const vcns = [];
  let nextPage = null;
  do {
    const json = await client.request({
      host,
      path: "/20160918/vcns",
      query: {
        compartmentId,
        ...(nextPage ? { page: nextPage } : {}),
      },
    });
    for (const item of ociListItems(json)) {
      if (typeof item !== "object" || !item) continue;
      const tags = /** @type {{ freeformTags?: Record<string, string> }} */ (item).freeformTags ?? {};
      const resourceId = resourceIdFromTags(tags);
      if (!resourceId) continue;
      vcns.push({ ...item, hdc_resource_id: resourceId });
    }
    nextPage = typeof json["opc-next-page"] === "string" ? json["opc-next-page"] : null;
  } while (nextPage);

  /** @type {Record<string, unknown>[]} */
  const subnets = [];
  nextPage = null;
  do {
    const json = await client.request({
      host,
      path: "/20160918/subnets",
      query: {
        compartmentId,
        ...(nextPage ? { page: nextPage } : {}),
      },
    });
    for (const item of ociListItems(json)) {
      if (typeof item !== "object" || !item) continue;
      const tags = /** @type {{ freeformTags?: Record<string, string> }} */ (item).freeformTags ?? {};
      const resourceId = resourceIdFromTags(tags);
      if (!resourceId) continue;
      subnets.push({ ...item, hdc_resource_id: resourceId });
    }
    nextPage = typeof json["opc-next-page"] === "string" ? json["opc-next-page"] : null;
  } while (nextPage);

  /** @type {Record<string, unknown>[]} */
  const nsgs = [];
  nextPage = null;
  do {
    const json = await client.request({
      host,
      path: "/20160918/networkSecurityGroups",
      query: {
        compartmentId,
        ...(nextPage ? { page: nextPage } : {}),
      },
    });
    for (const item of ociListItems(json)) {
      if (typeof item !== "object" || !item) continue;
      const tags = /** @type {{ freeformTags?: Record<string, string> }} */ (item).freeformTags ?? {};
      const resourceId = resourceIdFromTags(tags);
      if (!resourceId) continue;
      nsgs.push({ ...item, hdc_resource_id: resourceId });
    }
    nextPage = typeof json["opc-next-page"] === "string" ? json["opc-next-page"] : null;
  } while (nextPage);

  /** @type {Record<string, unknown>[]} */
  const instances = [];
  nextPage = null;
  do {
    const json = await client.request({
      host,
      path: "/20160918/instances",
      query: {
        compartmentId,
        ...(nextPage ? { page: nextPage } : {}),
      },
    });
    for (const item of ociListItems(json)) {
      if (typeof item !== "object" || !item) continue;
      const tags = /** @type {{ freeformTags?: Record<string, string> }} */ (item).freeformTags ?? {};
      const resourceId = resourceIdFromTags(tags);
      if (!resourceId) continue;
      instances.push({ ...item, hdc_resource_id: resourceId });
    }
    nextPage = typeof json["opc-next-page"] === "string" ? json["opc-next-page"] : null;
  } while (nextPage);

  /** @type {Record<string, unknown>[]} */
  const container_instances = [];
  if ((config.container_instances ?? []).length > 0) {
    const ciHost = `containerinstances.${client.region}.oci.oraclecloud.com`;
    nextPage = null;
    do {
      const json = await client.request({
        host: ciHost,
        path: "/20190918/containerInstances",
        query: {
          compartmentId,
          ...(nextPage ? { page: nextPage } : {}),
        },
      });
      for (const item of ociListItems(json)) {
        if (typeof item !== "object" || !item) continue;
        const tags = /** @type {{ freeformTags?: Record<string, string> }} */ (item).freeformTags ?? {};
        const resourceId = resourceIdFromTags(tags);
        if (!resourceId) continue;
        container_instances.push({ ...item, hdc_resource_id: resourceId });
      }
      nextPage = typeof json["opc-next-page"] === "string" ? json["opc-next-page"] : null;
    } while (nextPage);
  }

  /** @type {Record<string, unknown>[]} */
  const internet_gateways = [];
  nextPage = null;
  do {
    const json = await client.request({
      host,
      path: "/20160918/internetGateways",
      query: {
        compartmentId,
        ...(nextPage ? { page: nextPage } : {}),
      },
    });
    for (const item of ociListItems(json)) {
      if (typeof item !== "object" || !item) continue;
      const tags = /** @type {{ freeformTags?: Record<string, string> }} */ (item).freeformTags ?? {};
      const resourceId = resourceIdFromTags(tags);
      if (!resourceId) continue;
      internet_gateways.push({ ...item, hdc_resource_id: resourceId });
    }
    nextPage = typeof json["opc-next-page"] === "string" ? json["opc-next-page"] : null;
  } while (nextPage);

  /** @type {Record<string, unknown>[]} */
  const route_tables = [];
  nextPage = null;
  do {
    const json = await client.request({
      host,
      path: "/20160918/routeTables",
      query: {
        compartmentId,
        ...(nextPage ? { page: nextPage } : {}),
      },
    });
    for (const item of ociListItems(json)) {
      if (typeof item !== "object" || !item) continue;
      const tags = /** @type {{ freeformTags?: Record<string, string> }} */ (item).freeformTags ?? {};
      const resourceId = resourceIdFromTags(tags);
      if (!resourceId) continue;
      route_tables.push({ ...item, hdc_resource_id: resourceId });
    }
    nextPage = typeof json["opc-next-page"] === "string" ? json["opc-next-page"] : null;
  } while (nextPage);

  return {
    vcns,
    subnets,
    network_security_groups: nsgs,
    internet_gateways,
    route_tables,
    instances,
    container_instances,
    byResourceId(kind) {
      const map = new Map();
      for (const item of this[kind] ?? []) {
        const id = /** @type {{ hdc_resource_id?: string }} */ (item).hdc_resource_id;
        if (id) map.set(id, item);
      }
      return map;
    },
  };
}

/**
 * @param {NormalizedVcn} vcn
 * @param {NormalizedOciComputeConfig} config
 */
export function vcnTags(vcn, config) {
  return hdcFreeformTags(config.default_tags, vcn.tags, vcn.id);
}

/**
 * @param {NormalizedSubnet} subnet
 * @param {NormalizedOciComputeConfig} config
 */
export function subnetTags(subnet, config) {
  return hdcFreeformTags(config.default_tags, subnet.tags, subnet.id);
}

/**
 * @param {NormalizedNsg} nsg
 * @param {NormalizedOciComputeConfig} config
 */
export function nsgTags(nsg, config) {
  return hdcFreeformTags(config.default_tags, nsg.tags, nsg.id);
}

/**
 * @param {string} vcnId config id
 */
export function igwResourceId(vcnId) {
  return `${vcnId}-igw`;
}

/**
 * @param {string} vcnId config id
 */
export function routeTableResourceId(vcnId) {
  return `${vcnId}-rt`;
}
