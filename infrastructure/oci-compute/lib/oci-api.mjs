import { signOciRequest } from "./oci-request-sign.mjs";

/**
 * @param {string} region
 */
export function iaasHost(region) {
  return `iaas.${region}.oraclecloud.com`;
}

/**
 * @param {string} region
 */
export function identityHost(region) {
  return `identity.${region}.oci.oraclecloud.com`;
}

/**
 * @param {string} region
 */
export function containerInstancesHost(region) {
  return `containerinstances.${region}.oci.oraclecloud.com`;
}

/**
 * @param {object} opts
 * @param {import("./oci-request-sign.mjs").OciCredentials} opts.credentials
 * @param {string} opts.region
 * @param {string} opts.compartmentId
 */
export function createOciClient(opts) {
  const { credentials, region, compartmentId } = opts;

  /**
   * @param {object} req
   * @param {string} req.host
   * @param {string} req.path
   * @param {string} [req.method]
   * @param {unknown} [req.body]
   * @param {Record<string, string>} [req.query]
   */
  async function request(req) {
    const method = (req.method ?? "GET").toUpperCase();
    const query = req.query
      ? `?${new URLSearchParams(req.query).toString()}`
      : "";
    const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const signed = signOciRequest(credentials, {
      method,
      host: req.host,
      path: `${path}${query}`,
      body,
    });

    const url = `https://${req.host}${path}${query}`;
    const res = await fetch(url, {
      method,
      headers: signed,
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    /** @type {Record<string, unknown>} */
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (!res.ok) throw new Error(`OCI ${method} failed (${res.status})`);
        return { raw: text };
      }
    }
    if (!res.ok) {
      const msg =
        typeof json.message === "string"
          ? json.message
          : typeof json.code === "string"
            ? json.code
            : `HTTP ${res.status}`;
      throw new Error(`OCI ${method} ${path}: ${msg}`);
    }
    return json;
  }

  return {
    region,
    compartmentId,
    request,

    async listAvailabilityDomains() {
      const host = identityHost(region);
      const json = await request({
        host,
        path: `/20160918/availabilityDomains`,
        query: { compartmentId: credentials.tenancyOcid },
      });
      return ociListItems(json);
    },

    async resolveAvailabilityDomain(preferred) {
      const ads = await this.listAvailabilityDomains();
      if (!ads.length) throw new Error("No availability domains found in compartment");
      if (preferred) {
        const hit = ads.find(
          (ad) =>
            typeof ad === "object" &&
            ad &&
            (String(/** @type {{ name?: string }} */ (ad).name) === preferred ||
              String(/** @type {{ name?: string }} */ (ad).name).endsWith(preferred)),
        );
        if (hit && typeof hit === "object" && hit && "name" in hit) {
          return String(/** @type {{ name: string }} */ (hit).name);
        }
      }
      const first = ads[0];
      if (typeof first === "object" && first && "name" in first) {
        return String(/** @type {{ name: string }} */ (first).name);
      }
      throw new Error("Could not resolve availability domain");
    },
  };
}

/**
 * OCI list APIs return either a bare JSON array or an object with a `data` array.
 * @param {unknown} json
 * @returns {unknown[]}
 */
export function ociListItems(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && Array.isArray(/** @type {{ data?: unknown[] }} */ (json).data)) {
    return /** @type {{ data: unknown[] }} */ (json).data;
  }
  return [];
}

/** @typedef {ReturnType<typeof createOciClient>} OciClient */
