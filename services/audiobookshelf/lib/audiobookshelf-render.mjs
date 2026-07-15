/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} audiobookshelf
 */
export function normalizeImageTag(audiobookshelf) {
  const t = typeof audiobookshelf.image_tag === "string" ? audiobookshelf.image_tag.trim() : "";
  return t || "latest";
}

/**
 * @param {Record<string, unknown>} audiobookshelf
 */
export function hostPort(audiobookshelf) {
  const p =
    typeof audiobookshelf.host_port === "number" ? audiobookshelf.host_port : Number(audiobookshelf.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 13378;
}

/**
 * @param {Record<string, unknown>} audiobookshelf
 */
export function normalizeTimezone(audiobookshelf) {
  const tz = typeof audiobookshelf.timezone === "string" ? audiobookshelf.timezone.trim() : "";
  return tz || "America/Chicago";
}

/**
 * @param {Record<string, unknown>} audiobookshelf
 */
export function normalizePublicUrl(audiobookshelf) {
  const u = typeof audiobookshelf.public_url === "string" ? audiobookshelf.public_url.trim() : "";
  if (!u) return null;
  return u.replace(/\/+$/, "");
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/audiobookshelf";
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataMount(install) {
  return typeof install.data_mount === "string" && install.data_mount.trim()
    ? install.data_mount.trim()
    : "/data/audiobookshelf";
}

/**
 * @param {Record<string, unknown>} audiobookshelf
 * @param {Record<string, unknown>} install
 */
export function renderAudiobookshelfEnv(audiobookshelf, install) {
  const tag = normalizeImageTag(audiobookshelf);
  const port = hostPort(audiobookshelf);
  const tz = normalizeTimezone(audiobookshelf);
  const dm = dataMount(install);
  const lines = [
    "# hdc-generated — docker compose",
    `AUDIOBOOKSHELF_IMAGE_TAG=${tag}`,
    `AUDIOBOOKSHELF_HOST_PORT=${port}`,
    `TZ=${tz}`,
    `DATA_MOUNT=${dm}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:\${AUDIOBOOKSHELF_IMAGE_TAG}
    container_name: audiobookshelf
    restart: unless-stopped
    ports:
      - "\${AUDIOBOOKSHELF_HOST_PORT}:80"
    volumes:
      - \${DATA_MOUNT}/audiobooks:/audiobooks
      - \${DATA_MOUNT}/podcasts:/podcasts
      - \${DATA_MOUNT}/ebooks:/ebooks
      - \${DATA_MOUNT}/config:/config
      - \${DATA_MOUNT}/metadata:/metadata
    environment:
      - TZ=\${TZ}
`;
}

/**
 * @param {string | null} guestIp
 * @param {Record<string, unknown>} audiobookshelf
 */
export function resolveUpstreamUrl(guestIp, audiobookshelf) {
  const port = hostPort(audiobookshelf);
  if (guestIp) return `http://${guestIp}:${port}`;
  return null;
}

/**
 * @param {Record<string, unknown>} audiobookshelf
 * @param {string | null} guestIp
 */
export function resolveWebUrl(audiobookshelf, guestIp) {
  const publicUrl = normalizePublicUrl(audiobookshelf);
  if (publicUrl) return publicUrl;
  const upstream = resolveUpstreamUrl(guestIp, audiobookshelf);
  return upstream;
}

/**
 * @param {Record<string, unknown>} audiobookshelf
 */
export function resolvePublicUrl(audiobookshelf) {
  return normalizePublicUrl(isObject(audiobookshelf) ? audiobookshelf : {});
}
