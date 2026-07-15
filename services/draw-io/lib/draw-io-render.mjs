/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} drawIo
 */
export function normalizePublicUrl(drawIo) {
  const d = typeof drawIo.public_url === "string" ? drawIo.public_url.trim() : "";
  if (!d) {
    throw new Error("draw_io.public_url is required (https://… for nginx-waf)");
  }
  if (!/^https:\/\//i.test(d)) {
    throw new Error("draw_io.public_url must start with https://");
  }
  return d.replace(/\/+$/, "");
}

/**
 * @param {Record<string, unknown>} drawIo
 */
export function publicDnsFromUrl(drawIo) {
  const url = normalizePublicUrl(drawIo);
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`draw_io.public_url is not a valid URL: ${url}`);
  }
}

/**
 * @param {Record<string, unknown>} drawIo
 */
export function normalizeImageTag(drawIo) {
  const t = typeof drawIo.image_tag === "string" ? drawIo.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} drawIo
 */
export function hostPort(drawIo) {
  const p = typeof drawIo.host_port === "number" ? drawIo.host_port : Number(drawIo.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8080;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/draw-io";
}

/**
 * @param {Record<string, unknown>} drawIo
 */
export function renderDrawIoEnv(drawIo) {
  const tag = normalizeImageTag(drawIo);
  const port = hostPort(drawIo);
  const publicDns = publicDnsFromUrl(drawIo);

  const lines = [
    "# hdc-generated — docker compose",
    `DRAW_IO_IMAGE_TAG=${tag}`,
    `DRAW_IO_HOST_PORT=${port}`,
    `PUBLIC_DNS=${publicDns}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderComposeYaml() {
  return `services:
  drawio:
    image: jgraph/drawio:\${DRAW_IO_IMAGE_TAG}
    container_name: drawio
    restart: unless-stopped
    ports:
      - "\${DRAW_IO_HOST_PORT}:8080"
    environment:
      PUBLIC_DNS: \${PUBLIC_DNS}
    security_opt:
      - apparmor:unconfined

`;
}

/**
 * @param {Record<string, unknown>} drawIo
 */
export function resolveWebUrl(drawIo) {
  return normalizePublicUrl(drawIo);
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} drawIo
 */
export function resolveUpstreamUrl(ctIp, drawIo) {
  const port = hostPort(drawIo);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
