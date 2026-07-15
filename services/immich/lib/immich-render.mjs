/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} release `latest` or tag like `v1.118.0`
 */
function releaseTag(release) {
  const r = typeof release === "string" && release.trim() ? release.trim() : "latest";
  if (r === "latest" || r === "main") return "latest";
  return r.startsWith("v") ? r : `v${r}`;
}

/**
 * Official Immich docker-compose.yml URL for a release.
 * @param {string} release
 */
export function composeFileUrl(release) {
  const tag = releaseTag(release);
  if (tag === "latest") {
    return "https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml";
  }
  return `https://github.com/immich-app/immich/releases/download/${encodeURIComponent(tag)}/docker-compose.yml`;
}

/**
 * Official Immich example.env URL for a release.
 * @param {string} release
 */
export function envExampleUrl(release) {
  const tag = releaseTag(release);
  if (tag === "latest") {
    return "https://github.com/immich-app/immich/releases/latest/download/example.env";
  }
  return `https://github.com/immich-app/immich/releases/download/${encodeURIComponent(tag)}/example.env`;
}

/**
 * Resolve paths relative to compose_dir when not absolute.
 * @param {string} composeDirPath
 * @param {string} path
 */
function resolveStoragePath(composeDirPath, path) {
  const p = typeof path === "string" ? path.trim() : "";
  if (!p) return "";
  if (p.startsWith("/")) return p;
  const base = composeDirPath.replace(/\/$/, "");
  return `${base}/${p.replace(/^\.\//, "")}`;
}

/**
 * @param {Record<string, unknown>} immich
 * @param {Record<string, unknown>} install
 * @param {string} dbPassword
 */
export function renderImmichEnv(immich, install, dbPassword) {
  const dir = composeDir(install);
  const release = typeof immich.release === "string" ? immich.release : "latest";
  const tag = releaseTag(release);
  const tz =
    typeof immich.timezone === "string" && immich.timezone.trim() ? immich.timezone.trim() : "UTC";
  const uploadRaw =
    typeof immich.upload_location === "string" && immich.upload_location.trim()
      ? immich.upload_location.trim()
      : "./library";
  const dbRaw =
    typeof immich.db_data_location === "string" && immich.db_data_location.trim()
      ? immich.db_data_location.trim()
      : "./postgres";
  const upload = resolveStoragePath(dir, uploadRaw);
  const dbData = resolveStoragePath(dir, dbRaw);
  const disableMl = immich.disable_machine_learning === true;

  /** @type {Record<string, string>} */
  const vars = {
    UPLOAD_LOCATION: upload,
    DB_DATA_LOCATION: dbData,
    DB_PASSWORD: dbPassword,
    DB_USERNAME: "postgres",
    DB_DATABASE_NAME: "immich",
    TZ: tz,
  };
  if (tag !== "latest") {
    vars.IMMICH_VERSION = tag.startsWith("v") ? tag.slice(1) : tag;
  }
  if (disableMl) {
    vars.MACHINE_LEARNING_ENABLED = "false";
  }

  const publicUrl =
    typeof immich.public_url === "string" && immich.public_url.trim()
      ? immich.public_url.trim()
      : "";
  if (publicUrl) {
    vars.IMMICH_SERVER_URL = publicUrl;
  }

  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/immich";
}

/**
 * @param {Record<string, unknown>} immich
 * @param {string | null} sshHost
 */
export function resolvePublicUrl(immich, sshHost) {
  const configured =
    typeof immich.public_url === "string" && immich.public_url.trim()
      ? immich.public_url.trim()
      : null;
  if (configured) return configured;
  const port =
    typeof immich.port === "number" && Number.isFinite(immich.port) ? immich.port : 2283;
  if (sshHost) return `http://${sshHost}:${port}`;
  return null;
}

/**
 * Default library and DB paths when a data disk is mounted at /data/immich.
 */
export function defaultDataDiskPaths() {
  return {
    upload_location: "/data/immich/library",
    db_data_location: "/data/immich/postgres",
  };
}
