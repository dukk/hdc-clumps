/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const HDC_SITE_COMMENT_PREFIX = "hdc:site:";

/**
 * @param {string} siteId
 * @param {string} [userComment]
 */
export function hdcManagedComment(siteId, userComment) {
  const id = String(siteId).trim();
  const extra = typeof userComment === "string" ? userComment.trim() : "";
  return extra ? `${HDC_SITE_COMMENT_PREFIX}${id} ${extra}` : `${HDC_SITE_COMMENT_PREFIX}${id}`;
}

/**
 * @param {unknown} comment
 * @returns {string | null}
 */
export function parseHdcSiteIdFromComment(comment) {
  const s = typeof comment === "string" ? comment.trim() : "";
  const m = s.match(/^hdc:site:([a-z0-9][a-z0-9_-]*)/);
  return m ? m[1] : null;
}

/**
 * @param {Record<string, unknown>} safeline
 */
export function imageTag(safeline) {
  const tag = typeof safeline.image_tag === "string" ? safeline.image_tag.trim() : "";
  return tag || "latest";
}

/**
 * @param {Record<string, unknown>} safeline
 */
export function mgtPort(safeline) {
  const p = typeof safeline.mgt_port === "number" ? safeline.mgt_port : Number(safeline.mgt_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 9443;
}

/**
 * @param {Record<string, unknown>} safeline
 */
export function subnetPrefix(safeline) {
  const p = typeof safeline.subnet_prefix === "string" ? safeline.subnet_prefix.trim() : "";
  return p || "172.22.222";
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  const d = typeof install.compose_dir === "string" ? install.compose_dir.trim() : "";
  return d || "/opt/safeline";
}

/**
 * @param {Record<string, unknown>} safeline
 */
export function postgresVaultKey(safeline) {
  const k =
    typeof safeline.postgres_password_vault_key === "string"
      ? safeline.postgres_password_vault_key.trim()
      : "";
  return k || "HDC_SAFELINE_POSTGRES_PASSWORD";
}

/**
 * International (English) edition image suffix. Empty string selects Chinese CE images.
 * @param {Record<string, unknown>} safeline
 */
export function imageRegion(safeline) {
  const region = typeof safeline.region === "string" ? safeline.region.trim() : "";
  if (region) return region;
  return "-g";
}

/**
 * @param {Record<string, unknown>} safeline
 */
export function apiTokenVaultKey(safeline) {
  const k = typeof safeline.api_token_vault_key === "string" ? safeline.api_token_vault_key.trim() : "";
  return k || "HDC_SAFELINE_API_TOKEN";
}

/**
 * @param {Record<string, unknown>} safeline
 */
export function adminPasswordVaultKey(safeline) {
  const k =
    typeof safeline.admin_password_vault_key === "string"
      ? safeline.admin_password_vault_key.trim()
      : "";
  return k || "HDC_SAFELINE_ADMIN_PASSWORD";
}

/**
 * @param {Record<string, unknown>} safeline
 * @param {string} postgresPassword
 * @param {Record<string, unknown>} install
 */
export function renderSafelineEnv(safeline, postgresPassword, install) {
  const dir = composeDir(install);
  const prefix = typeof safeline.image_prefix === "string" ? safeline.image_prefix.trim() : "chaitin";
  const region = imageRegion(safeline);
  const archSuffix = typeof safeline.arch_suffix === "string" ? safeline.arch_suffix : "";
  const release = typeof safeline.release === "string" ? safeline.release : "";
  const lines = [
    `SAFELINE_DIR=${dir}`,
    `IMAGE_TAG=${imageTag(safeline)}`,
    `MGT_PORT=${mgtPort(safeline)}`,
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `SUBNET_PREFIX=${subnetPrefix(safeline)}`,
    `IMAGE_PREFIX=${prefix || "chaitin"}`,
    `REGION=${region}`,
    `ARCH_SUFFIX=${archSuffix}`,
    `RELEASE=${release}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} site
 */
export function validateSiteConfig(site) {
  const id = typeof site.id === "string" ? site.id.trim() : "";
  if (!id) throw new Error("each site needs id");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error(`site id ${JSON.stringify(id)} must be lowercase slug`);
  }
  const serverNames = Array.isArray(site.server_names)
    ? site.server_names.map((n) => String(n).trim()).filter(Boolean)
    : [];
  if (!serverNames.length) throw new Error(`site ${id}: server_names[] required`);
  const ports = Array.isArray(site.ports)
    ? site.ports.map((p) => String(p).trim()).filter(Boolean)
    : [];
  if (!ports.length) throw new Error(`site ${id}: ports[] required`);
  const upstreams = Array.isArray(site.upstreams)
    ? site.upstreams.map((u) => String(u).trim()).filter(Boolean)
    : [];
  if (!upstreams.length) throw new Error(`site ${id}: upstreams[] required`);
}

/**
 * @param {Record<string, unknown>} site
 */
export function siteToApiPayload(site) {
  validateSiteConfig(site);
  const id = String(site.id).trim();
  const userComment = typeof site.comment === "string" ? site.comment.trim() : "";
  const lb = isObject(site.load_balance) ? site.load_balance : { balance_type: 1 };
  /** @type {Record<string, unknown>} */
  const payload = {
    ports: site.ports.map((p) => String(p).trim()),
    server_names: site.server_names.map((n) => String(n).trim()),
    upstreams: site.upstreams.map((u) => String(u).trim()),
    comment: hdcManagedComment(id, userComment),
    load_balance: lb,
  };
  if (site.ssl === true) payload.ssl = true;
  return payload;
}

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
export function sitePayloadsEqual(a, b) {
  const keys = ["ports", "server_names", "upstreams", "comment", "ssl"];
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (key === "ssl") {
      const aSsl = av === true;
      const bSsl = bv === true;
      if (aSsl !== bSsl) return false;
      continue;
    }
    const aJson = JSON.stringify(av ?? null);
    const bJson = JSON.stringify(bv ?? null);
    if (aJson !== bJson) return false;
  }
  return true;
}

/**
 * @param {string | null} ip
 * @param {Record<string, unknown>} safeline
 */
export function resolveMgtUrl(ip, safeline) {
  if (!ip) return null;
  return `https://${ip}:${mgtPort(safeline)}`;
}

/**
 * @param {string | null} ip
 * @param {Record<string, unknown>} safeline
 */
export function resolveWebUrl(ip, safeline) {
  return resolveMgtUrl(ip, safeline);
}
