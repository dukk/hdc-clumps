/**
 * @param {Record<string, unknown>} a2aRegistry
 */
export function normalizePypiVersion(a2aRegistry) {
  const v = typeof a2aRegistry.pypi_version === "string" ? a2aRegistry.pypi_version.trim() : "";
  if (!v) return "0.1.5";
  if (!/^[0-9A-Za-z._+-]+$/.test(v)) {
    throw new Error(`a2a_registry.pypi_version is invalid: ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * @param {Record<string, unknown>} a2aRegistry
 */
export function imageTag(a2aRegistry) {
  return `hdc/a2a-registry:${normalizePypiVersion(a2aRegistry)}`;
}

/**
 * @param {Record<string, unknown>} a2aRegistry
 */
export function hostPort(a2aRegistry) {
  const p =
    typeof a2aRegistry.host_port === "number" ? a2aRegistry.host_port : Number(a2aRegistry.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8000;
}

/**
 * @param {Record<string, unknown>} a2aRegistry
 */
export function normalizeLogLevel(a2aRegistry) {
  const level = typeof a2aRegistry.log_level === "string" ? a2aRegistry.log_level.trim() : "";
  if (!level) return "INFO";
  if (!/^[A-Za-z]+$/.test(level)) {
    throw new Error(`a2a_registry.log_level is invalid: ${JSON.stringify(level)}`);
  }
  return level.toUpperCase();
}

/**
 * @param {Record<string, unknown>} a2aRegistry
 * @returns {URL | null}
 */
export function parsePublicUrl(a2aRegistry) {
  const raw = a2aRegistry.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`a2a_registry.public_url is not a valid URL: ${JSON.stringify(s)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("a2a_registry.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/a2a-registry";
}

/**
 * @param {Record<string, unknown>} a2aRegistry
 */
export function renderDockerfile(a2aRegistry) {
  const version = normalizePypiVersion(a2aRegistry);
  return `FROM python:3.12-slim
ARG A2A_REGISTRY_VERSION=${version}
RUN pip install --no-cache-dir "a2a-registry==\${A2A_REGISTRY_VERSION}"
EXPOSE 8000
CMD ["a2a-registry", "serve", "--host", "0.0.0.0", "--port", "8000"]
`;
}

/**
 * @param {Record<string, unknown>} a2aRegistry
 * @param {Record<string, unknown>} install
 */
export function renderComposeYaml(a2aRegistry, install) {
  void install;
  const version = normalizePypiVersion(a2aRegistry);
  const image = imageTag(a2aRegistry);
  const port = hostPort(a2aRegistry);
  const logLevel = normalizeLogLevel(a2aRegistry);
  return `services:
  a2a-registry:
    container_name: a2a-registry
    build:
      context: .
      args:
        A2A_REGISTRY_VERSION: "${version}"
    image: ${image}
    restart: unless-stopped
    ports:
      - "${port}:8000"
    command:
      - a2a-registry
      - serve
      - --host
      - "0.0.0.0"
      - --port
      - "8000"
      - --log-level
      - ${logLevel}
`;
}

/**
 * @param {Record<string, unknown>} a2aRegistry
 * @param {string | null} [ctIp]
 */
export function resolveWebUrl(a2aRegistry, ctIp = null) {
  const parsed = parsePublicUrl(a2aRegistry);
  if (parsed) {
    return parsed.origin.replace(/\/+$/, "");
  }
  const port = hostPort(a2aRegistry);
  const ip = typeof ctIp === "string" ? ctIp.trim() : "";
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} a2aRegistry
 */
export function resolveUpstreamUrl(ctIp, a2aRegistry) {
  const port = hostPort(a2aRegistry);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}
