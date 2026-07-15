/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Default nginx-waf peer LAN IPs (vm-nginx-waf-a/b). */
export const DEFAULT_TRUSTED_PROXIES = ["192.0.2.40", "192.0.2.41"];

/** MeshCentral HTTP port inside the container when TLS is offloaded to nginx-waf. */
export const MESHCENTRAL_HTTP_PORT = 4430;

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function normalizeImageTag(meshcentral) {
  const t = typeof meshcentral.image_tag === "string" ? meshcentral.image_tag.trim() : "";
  return t || "latest";
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function mongoPasswordVaultKey(meshcentral) {
  const key =
    typeof meshcentral.mongo_password_vault_key === "string" &&
    meshcentral.mongo_password_vault_key.trim()
      ? meshcentral.mongo_password_vault_key.trim()
      : "HDC_MESHCENTRAL_MONGO_PASSWORD";
  return key;
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function resolvePublicUrl(meshcentral) {
  const url = typeof meshcentral.public_url === "string" ? meshcentral.public_url.trim() : "";
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("meshcentral.public_url must start with http:// or https://");
  }
  return url.replace(/\/+$/, "");
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function resolveHostname(meshcentral) {
  const explicit =
    typeof meshcentral.hostname === "string" ? meshcentral.hostname.trim() : "";
  if (explicit) return explicit;
  const url = resolvePublicUrl(meshcentral);
  if (url) {
    try {
      return new URL(url).hostname;
    } catch {
      throw new Error("meshcentral.public_url is not a valid URL");
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function trustedProxies(meshcentral) {
  const raw = meshcentral.trusted_proxies;
  if (Array.isArray(raw) && raw.length > 0) {
    const list = raw
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    if (list.length) return list;
  }
  return [...DEFAULT_TRUSTED_PROXIES];
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function allowNewAccounts(meshcentral) {
  return meshcentral.allow_new_accounts === true;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/meshcentral";
}

/**
 * @param {string} password
 */
function encodeMongoPassword(password) {
  return encodeURIComponent(password);
}

/**
 * @param {Record<string, unknown>} meshcentral
 * @param {string} mongoPassword
 */
export function mongoUrl(meshcentral, mongoPassword) {
  const user =
    typeof meshcentral.mongo_username === "string" && meshcentral.mongo_username.trim()
      ? meshcentral.mongo_username.trim()
      : "meshcentral";
  const db =
    typeof meshcentral.mongo_database === "string" && meshcentral.mongo_database.trim()
      ? meshcentral.mongo_database.trim()
      : "meshcentral";
  const pass = encodeMongoPassword(mongoPassword);
  return `mongodb://${user}:${pass}@mongodb:27017/${db}?authSource=admin`;
}

/**
 * @param {Record<string, unknown>} meshcentral
 * @param {string} mongoPassword
 */
export function renderMeshcentralEnv(meshcentral, mongoPassword) {
  const hostname = resolveHostname(meshcentral);
  if (!hostname) {
    throw new Error("meshcentral.hostname or meshcentral.public_url is required");
  }
  const publicUrl = resolvePublicUrl(meshcentral);
  const certUrl = publicUrl ? `${publicUrl}/` : `https://${hostname}/`;
  const lines = [
    "# hdc-generated — docker compose",
    "NODE_ENV=production",
    "CONFIG_FILE=/opt/meshcentral/meshcentral-data/config.json",
    "DYNAMIC_CONFIG=true",
    `HOSTNAME=${hostname}`,
    `PORT=${MESHCENTRAL_HTTP_PORT}`,
    "REDIR_PORT=0",
    "TLS_OFFLOAD=true",
    `REVERSE_PROXY=${hostname}`,
    "REVERSE_PROXY_TLS_PORT=443",
    "TRUSTED_PROXY=true",
    `ALLOW_NEW_ACCOUNTS=${allowNewAccounts(meshcentral) ? "true" : "false"}`,
    "USE_MONGODB=true",
    `MONGO_URL=${mongoUrl(meshcentral, mongoPassword)}`,
    `MONGO_PASSWORD=${mongoPassword}`,
    `MONGO_INITDB_ROOT_USERNAME=${
      typeof meshcentral.mongo_username === "string" && meshcentral.mongo_username.trim()
        ? meshcentral.mongo_username.trim()
        : "meshcentral"
    }`,
    `MONGO_INITDB_ROOT_PASSWORD=${mongoPassword}`,
    `# hdc certUrl target (applied via config patch): ${certUrl}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Shell fragment: patch persisted config.json for reverse-proxy TLS offload (aliasPort + certUrl).
 * @param {string} composeDirPath
 * @param {Record<string, unknown>} meshcentral
 */
export function buildConfigPatchScript(composeDirPath, meshcentral) {
  const hostname = resolveHostname(meshcentral);
  if (!hostname) {
    throw new Error("meshcentral.hostname or meshcentral.public_url is required");
  }
  const publicUrl = resolvePublicUrl(meshcentral);
  const certUrl = publicUrl ? `${publicUrl}/` : `https://${hostname}/`;
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const certUrlJs = certUrl.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const nodePatch = [
    "const fs=require('fs');",
    "const p='/opt/meshcentral/meshcentral-data/config.json';",
    "if(!fs.existsSync(p)) process.exit(0);",
    "const c=JSON.parse(fs.readFileSync(p,'utf8'));",
    "c.settings=c.settings||{};",
    "c.settings.aliasPort=443;",
    `c.settings.certUrl='${certUrlJs}';`,
    "c.settings.redirPort=0;",
    "c.settings.tlsOffload=true;",
    `c.settings.port=${MESHCENTRAL_HTTP_PORT};`,
    "fs.writeFileSync(p,JSON.stringify(c,null,2));",
  ].join("");
  const nodePatchEsc = nodePatch.replace(/'/g, `'\\''`);

  return [
    `if test -f '${dir}/docker-compose.yml'; then`,
    `  cd '${dir}'`,
    "  MC_CONTAINER=$(docker compose ps -q meshcentral 2>/dev/null || true)",
    '  if test -n "$MC_CONTAINER"; then',
    "    for i in $(seq 1 30); do",
    "      docker compose exec -T meshcentral test -f /opt/meshcentral/meshcentral-data/config.json && break",
    "      sleep 2",
    "    done",
    `    docker compose exec -T meshcentral node -e '${nodePatchEsc}' || true`,
    "    docker compose restart meshcentral",
    "    sleep 5",
    "  fi",
    "fi",
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function renderComposeYaml(meshcentral) {
  const tag = normalizeImageTag(meshcentral);
  return `services:
  mongodb:
    image: mongo:7
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - mongodb-data:/data/db

  meshcentral:
    image: ghcr.io/ylianst/meshcentral:${tag}
    restart: unless-stopped
    depends_on:
      - mongodb
    env_file:
      - .env
    ports:
      - "${MESHCENTRAL_HTTP_PORT}:${MESHCENTRAL_HTTP_PORT}"
    volumes:
      - meshcentral-data:/opt/meshcentral/meshcentral-data
      - meshcentral-files:/opt/meshcentral/meshcentral-files
      - meshcentral-web:/opt/meshcentral/meshcentral-web
      - meshcentral-backups:/opt/meshcentral/meshcentral-backups

volumes:
  mongodb-data: {}
  meshcentral-data: {}
  meshcentral-files: {}
  meshcentral-web: {}
  meshcentral-backups: {}
`;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} meshcentral
 */
export function serviceSummary(ctIp, meshcentral) {
  const hostname = resolveHostname(meshcentral);
  const publicUrl = resolvePublicUrl(meshcentral);
  return {
    hostname,
    public_url: publicUrl,
    ct_ip: ctIp,
    http_port: MESHCENTRAL_HTTP_PORT,
    agent_hint: publicUrl
      ? `Install agents with server URL ${publicUrl}`
      : hostname
        ? `Browse https://${hostname} (via nginx-waf when configured)`
        : null,
  };
}
