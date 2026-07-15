/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const DEFAULT_IMAGE = "rustfs/rustfs:latest";
const DEFAULT_S3_PORT = 9000;
const DEFAULT_CONSOLE_PORT = 9001;
const DEFAULT_DRIVES = 4;
const DEFAULT_DATA_PREFIX = "/data/rustfs";

/**
 * @param {Record<string, unknown>} rustfs
 */
export function normalizeImage(rustfs) {
  const img = typeof rustfs.image === "string" ? rustfs.image.trim() : "";
  return img || DEFAULT_IMAGE;
}

/**
 * @param {Record<string, unknown>} rustfs
 */
export function s3Port(rustfs) {
  const p = typeof rustfs.s3_port === "number" ? rustfs.s3_port : Number(rustfs.s3_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return DEFAULT_S3_PORT;
}

/**
 * @param {Record<string, unknown>} rustfs
 */
export function consolePort(rustfs) {
  const p = typeof rustfs.console_port === "number" ? rustfs.console_port : Number(rustfs.console_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return DEFAULT_CONSOLE_PORT;
}

/**
 * @param {Record<string, unknown>} rustfs
 */
export function drivesPerNode(rustfs) {
  const n = typeof rustfs.drives_per_node === "number" ? rustfs.drives_per_node : Number(rustfs.drives_per_node);
  if (Number.isFinite(n) && n >= 1 && n <= 16) return Math.floor(n);
  return DEFAULT_DRIVES;
}

/**
 * @param {Record<string, unknown>} rustfs
 */
export function dataPathPrefix(rustfs) {
  const p = typeof rustfs.data_path_prefix === "string" ? rustfs.data_path_prefix.trim() : "";
  return p || DEFAULT_DATA_PREFIX;
}

/**
 * @param {Record<string, unknown>} rustfs
 */
export function unsafeBypassDiskCheck(rustfs) {
  return rustfs.unsafe_bypass_disk_check === true;
}

/**
 * @param {Record<string, unknown>} rustfs
 * @returns {URL | null}
 */
export function parseS3PublicUrl(rustfs) {
  const raw = rustfs.s3_public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`rustfs.s3_public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("rustfs.s3_public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} rustfs
 * @returns {URL | null}
 */
export function parseConsolePublicUrl(rustfs) {
  const raw = rustfs.console_public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`rustfs.console_public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("rustfs.console_public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/rustfs";
}

/**
 * @param {Record<string, unknown>} install
 */
export function dataDir(install) {
  return `${composeDir(install)}/data`;
}

/**
 * @param {Record<string, unknown>} install
 */
export function logsDir(install) {
  return `${composeDir(install)}/logs`;
}

/**
 * @param {number} count
 */
function driveBraceExpansion(count) {
  if (count === 1) return "1";
  return `{1...${count}}`;
}

/**
 * @param {{ hostname: string }[]} peers
 * @param {Record<string, unknown>} rustfs
 */
export function buildRustfsVolumesEnv(peers, rustfs) {
  const port = s3Port(rustfs);
  const drives = drivesPerNode(rustfs);
  const prefix = dataPathPrefix(rustfs).replace(/\/+$/, "");
  const driveExpand = driveBraceExpansion(drives);
  return peers
    .map((p) => `http://${p.hostname}:${port}${prefix}${driveExpand}`)
    .join(",");
}

/**
 * @param {Record<string, unknown>} rustfs
 */
export function consoleCorsOrigins(rustfs) {
  const raw = rustfs.console_cors_allowed_origins;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "*";
}

/**
 * @param {Record<string, unknown>} rustfs
 * @param {string | null} [ctIp]
 */
export function resolveS3LanUrl(rustfs, ctIp = null) {
  const parsed = parseS3PublicUrl(rustfs);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = s3Port(rustfs);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {Record<string, unknown>} rustfs
 * @param {string | null} [ctIp]
 */
export function resolveConsoleLanUrl(rustfs, ctIp = null) {
  const parsed = parseConsolePublicUrl(rustfs);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = consolePort(rustfs);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} rustfs
 */
export function resolveS3UpstreamUrl(ctIp, rustfs) {
  const port = s3Port(rustfs);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} rustfs
 */
export function resolveConsoleUpstreamUrl(ctIp, rustfs) {
  const port = consolePort(rustfs);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {{ ctIp: string | null }[]} nodes
 * @param {Record<string, unknown>} rustfs
 */
export function resolveS3UpstreamPool(nodes, rustfs) {
  const port = s3Port(rustfs);
  return nodes
    .map((n) => (n.ctIp ? `http://${n.ctIp}:${port}` : null))
    .filter(Boolean);
}

/**
 * @param {Record<string, unknown>} rustfs
 * @param {string} rustfsVolumes
 * @param {string} accessKey
 * @param {string} secretKey
 */
export function renderEnvFile(rustfs, rustfsVolumes, accessKey, secretKey) {
  const s3 = s3Port(rustfs);
  const console = consolePort(rustfs);
  const bypass = unsafeBypassDiskCheck(rustfs) ? "true" : "false";
  const cors = consoleCorsOrigins(rustfs);

  const lines = [
    "# hdc-generated — docker compose env",
    `RUSTFS_S3_PORT=${s3}`,
    `RUSTFS_CONSOLE_PORT=${console}`,
    `RUSTFS_VOLUMES=${rustfsVolumes}`,
    `RUSTFS_ACCESS_KEY=${accessKey}`,
    `RUSTFS_SECRET_KEY=${secretKey}`,
    "RUSTFS_ADDRESS=0.0.0.0:9000",
    "RUSTFS_CONSOLE_ADDRESS=0.0.0.0:9001",
    "RUSTFS_CONSOLE_ENABLE=true",
    `RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=${cors}`,
    "RUSTFS_OBS_LOGGER_LEVEL=info",
    `RUSTFS_UNSAFE_BYPASS_DISK_CHECK=${bypass}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} rustfs
 */
export function renderComposeYaml(rustfs) {
  const image = normalizeImage(rustfs);
  const drives = drivesPerNode(rustfs);
  const volumeLines = [];
  for (let i = 1; i <= drives; i += 1) {
    volumeLines.push(`      - ./data/rustfs${i}:/data/rustfs${i}`);
  }

  return `services:
  rustfs:
    image: ${image}
    container_name: rustfs-server
    security_opt:
      - "no-new-privileges:true"
    ports:
      - "\${RUSTFS_S3_PORT:-9000}:9000"
      - "\${RUSTFS_CONSOLE_PORT:-9001}:9001"
    environment:
      - RUSTFS_VOLUMES=\${RUSTFS_VOLUMES}
      - RUSTFS_ADDRESS=\${RUSTFS_ADDRESS:-0.0.0.0:9000}
      - RUSTFS_CONSOLE_ADDRESS=\${RUSTFS_CONSOLE_ADDRESS:-0.0.0.0:9001}
      - RUSTFS_CONSOLE_ENABLE=\${RUSTFS_CONSOLE_ENABLE:-true}
      - RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=\${RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS:-*}
      - RUSTFS_ACCESS_KEY=\${RUSTFS_ACCESS_KEY}
      - RUSTFS_SECRET_KEY=\${RUSTFS_SECRET_KEY}
      - RUSTFS_OBS_LOGGER_LEVEL=\${RUSTFS_OBS_LOGGER_LEVEL:-info}
      - RUSTFS_UNSAFE_BYPASS_DISK_CHECK=\${RUSTFS_UNSAFE_BYPASS_DISK_CHECK:-false}
    volumes:
${volumeLines.join("\n")}
      - ./logs:/app/logs
    restart: unless-stopped
    healthcheck:
      test:
        [
          "CMD",
          "sh",
          "-ec",
          "curl -fsS http://127.0.0.1:9000/health && curl -fsS http://127.0.0.1:9001/rustfs/console/health"
        ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
`;
}
