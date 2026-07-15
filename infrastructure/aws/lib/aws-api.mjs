import { awsSignedFetch } from "hdc/package/aws-sigv4.mjs";

/** @typedef {import("../../../lib/aws-sigv4.mjs").AwsCredentials} AwsCredentials */

/**
 * @param {Record<string, string | number | boolean | string[] | undefined | null>} params
 * @param {string} [prefix]
 * @param {URLSearchParams} [out]
 */
function flattenQueryParams(params, prefix = "", out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        if (typeof item === "object" && item !== null) {
          flattenQueryParams(/** @type {Record<string, unknown>} */ (item), `${fullKey}.${idx + 1}`, out);
        } else {
          out.append(`${fullKey}.${idx + 1}`, String(item));
        }
      });
    } else if (typeof value === "boolean") {
      out.append(fullKey, value ? "true" : "false");
    } else {
      out.append(fullKey, String(value));
    }
  }
  return out;
}

/**
 * Parse AWS Query API XML responses (minimal subset for Describe* calls).
 * @param {string} xml
 */
export function parseAwsQueryXml(xml) {
  /** @type {Record<string, unknown>} */
  const result = {};
  const itemRegex = /<([A-Za-z0-9]+)>([^<]*)<\/\1>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const [, tag, value] = m;
    if (tag === "requestId" || tag === "RequestId") continue;
    if (result[tag] === undefined) {
      result[tag] = value;
    } else if (Array.isArray(result[tag])) {
      result[tag].push(value);
    } else {
      result[tag] = [result[tag], value];
    }
  }
  return result;
}

/**
 * Extract repeated member blocks from EC2-style XML.
 * @param {string} xml
 * @param {string} setName e.g. vpcSet, item
 */
export function parseAwsXmlItems(xml, setName = "item") {
  const re = new RegExp(`<${setName}>([\\s\\S]*?)</${setName}>`, "g");
  /** @type {Record<string, string>[]} */
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    /** @type {Record<string, string>} */
    const item = {};
    const tagRe = /<([A-Za-z0-9]+)>([^<]*)<\/\1>/g;
    let t;
    while ((t = tagRe.exec(block)) !== null) {
      item[t[1]] = t[2];
    }
    if (Object.keys(item).length) items.push(item);
  }
  return items;
}

/**
 * @param {string} xml
 */
export function awsQueryErrorMessage(xml) {
  const err = xml.match(/<Message>([^<]+)<\/Message>/);
  const code = xml.match(/<Code>([^<]+)<\/Code>/);
  if (err) return code ? `${err[1]} (${code[1]})` : err[1];
  return "AWS API request failed";
}

/**
 * @param {object} opts
 * @param {AwsCredentials} opts.credentials
 * @param {string} opts.region
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createAwsClient(opts) {
  const { credentials, region } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  /**
   * @param {string} service
   * @param {string} host
   * @param {string} action
   * @param {Record<string, string | number | boolean | string[] | undefined | null>} params
   * @param {string} version
   */
  async function queryRequest(service, host, action, params, version) {
    const body = flattenQueryParams({ Action: action, Version: version, ...params }).toString();
    const url = `https://${host}/`;
    const res = await awsSignedFetch(
      {
        method: "POST",
        url,
        body,
        credentials,
        region,
        service,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      },
      fetchImpl,
    );
    const text = await res.text();
    if (!res.ok || text.includes("<Error>")) {
      throw new Error(awsQueryErrorMessage(text) || `AWS ${action} HTTP ${res.status}`);
    }
    return text;
  }

  /**
   * @param {string} action
   * @param {Record<string, string | number | boolean | string[] | undefined | null>} [params]
   */
  async function ec2(action, params = {}) {
    return queryRequest("ec2", `ec2.${region}.amazonaws.com`, action, params, "2016-11-15");
  }

  /**
   * @param {string} action
   * @param {Record<string, string | number | boolean | string[] | undefined | null>} [params]
   */
  async function iam(action, params = {}) {
    return queryRequest("iam", "iam.amazonaws.com", action, params, "2010-05-08");
  }

  /**
   * @param {string} action
   * @param {Record<string, string | number | boolean | string[] | undefined | null>} [params]
   */
  async function ecs(action, params = {}) {
    return queryRequest("ecs", `ecs.${region}.amazonaws.com`, action, params, "2014-11-13");
  }

  /**
   * @param {string} method
   * @param {string} bucket
   * @param {string} [path]
   * @param {Record<string, string>} [headers]
   * @param {string} [body]
   */
  async function s3(method, bucket, path = "", headers = {}, body) {
    const url = `https://${bucket}.s3.${region}.amazonaws.com${path}`;
    const res = await awsSignedFetch(
      {
        method,
        url,
        body,
        credentials,
        region,
        service: "s3",
        headers,
      },
      fetchImpl,
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`S3 ${method} ${bucket}${path} failed: HTTP ${res.status}`);
    }
    return { status: res.status, text, headers: Object.fromEntries(res.headers.entries()) };
  }

  return {
    region,
    credentials,
    ec2,
    iam,
    ecs,
    s3,
    queryRequest,
  };
}

/**
 * @param {Record<string, string>} tags
 */
export function ec2TagParams(tags, prefix = "TagSpecification.1.Tag") {
  /** @type {Record<string, string>} */
  const out = {
    "TagSpecification.1.ResourceType": "instance",
  };
  let i = 1;
  for (const [key, value] of Object.entries(tags)) {
    out[`${prefix}.${i}.Key`] = key;
    out[`${prefix}.${i}.Value`] = value;
    i++;
  }
  return out;
}
