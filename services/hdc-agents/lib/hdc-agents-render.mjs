import { formatA2aAgentDescription } from "hdc/cli/lib/litellm-a2a-metadata.mjs";

/** Augmentor bridge sidecar default port on hdc-agents guest. */
export const AUGMENT_SIDECAR_PORT = 9210;

/** Agent roster: role id → host port on hdc-agents LXC. */
export const AGENT_ROSTER = [
  { role: "hdc-manager", port: 9200 },
  { role: "hdc-monitor", port: 9201 },
  { role: "hdc-maintainer", port: 9207 },
  { role: "hdc-sre-ops", port: 9202 },
  { role: "hdc-security-expert", port: 9203 },
  { role: "hdc-security-architect", port: 9204 },
  { role: "hdc-network-architect", port: 9205 },
  { role: "hdc-research", port: 9206 },
  { role: "hdc-sre-engineer", port: 9208 },
  { role: "hdc-qa", port: 9209 },
];

/** Roles that write digests/tasks under operations/ */
export const RW_OPERATIONS_ROLES = new Set([
  "hdc-manager",
  "hdc-monitor",
  "hdc-maintainer",
  "hdc-security-expert",
  "hdc-research",
  "hdc-sre-ops",
  "hdc-qa",
]);

/**
 * @param {Record<string, unknown>} hdcAgents
 */
export function normalizeImageTag(hdcAgents) {
  const t = typeof hdcAgents.image_tag === "string" ? hdcAgents.image_tag.trim() : "";
  return t || "latest";
}

/**
 * @param {Record<string, unknown>} hdcAgents
 */
export function imageName(hdcAgents) {
  return `hdc/agent-runtime:${normalizeImageTag(hdcAgents)}`;
}

/**
 * @param {Record<string, unknown>} hdcAgents
 */
export function litellmBaseUrl(hdcAgents) {
  const u = typeof hdcAgents.litellm_base_url === "string" ? hdcAgents.litellm_base_url.trim() : "";
  return u || "http://192.0.2.116:4000";
}

/**
 * @param {Record<string, unknown>} hdcAgents
 * @returns {typeof AGENT_ROSTER}
 */
export function enabledAgents(hdcAgents) {
  const raw = hdcAgents.agents;
  if (!Array.isArray(raw) || raw.length === 0) return AGENT_ROSTER;
  /** @type {typeof AGENT_ROSTER} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    if (o.enabled === false) continue;
    const role = typeof o.role === "string" ? o.role.trim() : "";
    const port = typeof o.port === "number" ? o.port : Number(o.port);
    if (!role || !Number.isFinite(port)) continue;
    out.push({ role, port: Math.floor(port) });
  }
  return out.length ? out : AGENT_ROSTER;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/hdc-agents";
}

/**
 * Dockerfile baked into the guest build context (hdc tree rsynced beside compose).
 * @param {Record<string, unknown>} hdcAgents
 */
export function renderDockerfile(hdcAgents) {
  void hdcAgents;
  return `FROM node:20-bookworm-slim
WORKDIR /opt/hdc
RUN apt-get update -qq \\
  && apt-get install -y -qq ca-certificates git \\
  && rm -rf /var/lib/apt/lists/*
COPY hdc/ /opt/hdc/
# Optional: package tree for hdc/clump/* resolution (skip when absent in build context).
COPY hdc-clumps/ /opt/hdc-clumps/
WORKDIR /opt/hdc/apps/hdc-mcp-server
RUN npm install --omit=dev --no-fund --no-audit || true
WORKDIR /opt/hdc/apps/hdc-web-server
RUN npm install --omit=dev --no-fund --no-audit || true
RUN npm run build || true
ENV HDC_ROOT=/opt/hdc
ENV HDC_CLUMPS_ROOT=/opt/hdc-clumps
ENV NODE_ENV=production
ENV NODE_OPTIONS=--import=/opt/hdc/apps/hdc-cli/lib/package/preload.mjs
WORKDIR /opt/hdc
EXPOSE 9120 9200
CMD ["node", "apps/hdc-agent-server/server.mjs"]
`;
}

/**
 * @param {Record<string, unknown>} hdcAgents
 * @param {Record<string, unknown>} install
 * @param {{ guestIp?: string | null; systemId?: string | null }} [opts]
 */
export function renderComposeYaml(hdcAgents, install, opts = {}) {
  const image = imageName(hdcAgents);
  const dir = composeDir(install);
  const litellm = litellmBaseUrl(hdcAgents).replace(/'/g, "''");
  const agents = enabledAgents(hdcAgents);
  const model =
    typeof hdcAgents.default_model === "string" && hdcAgents.default_model.trim()
      ? hdcAgents.default_model.trim()
      : "lan-best-available";
  const systemId =
    typeof opts.systemId === "string" && opts.systemId.trim() ? opts.systemId.trim() : "";

  /**
   * Append shared system identity env lines under an existing `environment:` block.
   * @param {string[]} lines
   * @param {string} [notifyApp]
   */
  function pushSystemEnv(lines, notifyApp) {
    if (systemId) lines.push(`      HDC_OPS_SYSTEM_ID: ${JSON.stringify(systemId)}`);
    if (notifyApp) lines.push(`      HDC_OPS_NOTIFY_APP: ${JSON.stringify(notifyApp)}`);
  }

  /** @type {string[]} */
  const lines = ["services:"];
  for (const { role, port } of agents) {
    const svc = role.replace(/_/g, "-");
    const opsMode = RW_OPERATIONS_ROLES.has(role) ? "rw" : "ro";
    const keyEnv = `HDC_AGENT_LITELLM_KEY_${role.replace(/-/g, "_").toUpperCase()}`;
    lines.push(`  ${svc}:`);
    lines.push(`    container_name: ${svc}`);
    if (systemId) lines.push(`    hostname: ${JSON.stringify(systemId)}`);
    lines.push(`    image: ${image}`);
    lines.push(`    build:`);
    lines.push(`      context: ${dir}`);
    lines.push(`      dockerfile: Dockerfile`);
    lines.push(`    restart: unless-stopped`);
    lines.push(`    env_file:`);
    lines.push(`      - ${dir}/.env`);
    lines.push(`    ports:`);
    lines.push(`      - "${port}:${port}/tcp"`);
    lines.push(`    environment:`);
    pushSystemEnv(lines);
    lines.push(`      HDC_AGENT_ROLE: ${role}`);
    lines.push(`      HDC_AGENT_PORT: "${port}"`);
    lines.push(`      HDC_ROOT: /opt/hdc`);
    lines.push(`      HDC_PRIVATE_ROOT: /opt/hdc-private`);
    lines.push(`      HDC_LITELLM_BASE_URL: '${litellm}'`);
    lines.push(`      HDC_AGENT_MODEL: '${model.replace(/'/g, "''")}'`);
    lines.push(`      HDC_AGENT_LITELLM_KEY: \${${keyEnv}:-}`);
    const mcpKeyEnv = `HDC_MCP_API_KEY_${role.replace(/-/g, "_").toUpperCase()}`;
    lines.push(`      HDC_MCP_API_KEY: \${${mcpKeyEnv}:-}`);
    lines.push(`      HDC_MCP_REQUIRE_API_KEY: "1"`);
    lines.push(`      HDC_AGENTS_META_ROOT: /opt/hdc-agents-meta`);
    lines.push(`    volumes:`);
    lines.push(`      - /opt/hdc-private:/opt/hdc-private:${opsMode}`);
    lines.push(`      - /opt/hdc-agents-meta:/opt/hdc-agents-meta:ro`);
  }

  // CLI job scheduler (no LiteLLM)
  lines.push(`  hdc-scheduler:`);
  lines.push(`    container_name: hdc-scheduler`);
  if (systemId) lines.push(`    hostname: ${JSON.stringify(systemId)}`);
  lines.push(`    image: ${image}`);
  lines.push(`    build:`);
  lines.push(`      context: ${dir}`);
  lines.push(`      dockerfile: Dockerfile`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    env_file:`);
  lines.push(`      - ${dir}/.env`);
  lines.push(`    command: ["node", "apps/hdc-agent-server/bin/scheduler.mjs"]`);
  lines.push(`    environment:`);
  pushSystemEnv(lines);
  lines.push(`      HDC_AGENT_ROLE: hdc-scheduler`);
  lines.push(`      HDC_ROOT: /opt/hdc`);
  lines.push(`      HDC_PRIVATE_ROOT: /opt/hdc-private`);
  lines.push(`      HDC_AGENTS_META_ROOT: /opt/hdc-agents-meta`);
  lines.push(`      HDC_MCP_API_KEY: \${HDC_MCP_API_KEY_HDC_SCHEDULER:-}`);
  lines.push(`      HDC_MCP_REQUIRE_API_KEY: "1"`);
  lines.push(`    volumes:`);
  lines.push(`      - /opt/hdc-private:/opt/hdc-private:rw`);
  lines.push(`      - /opt/hdc-agents-meta:/opt/hdc-agents-meta:rw`);
  if (opts.mountHdcSrc !== false) {
    lines.push(`      - /opt/hdc-src:/opt/hdc:ro`);
  }

  // Ops web UI (React)
  lines.push(`  hdc-web:`);
  lines.push(`    container_name: hdc-web`);
  if (systemId) lines.push(`    hostname: ${JSON.stringify(systemId)}`);
  lines.push(`    image: ${image}`);
  lines.push(`    build:`);
  lines.push(`      context: ${dir}`);
  lines.push(`      dockerfile: Dockerfile`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    env_file:`);
  lines.push(`      - ${dir}/.env`);
  lines.push(`    command: ["node", "apps/hdc-web-server/server.mjs"]`);
  lines.push(`    ports:`);
  lines.push(`      - "9120:9120/tcp"`);
  lines.push(`    environment:`);
  pushSystemEnv(lines, "web");
  lines.push(`      HDC_WEB_PORT: "9120"`);
  lines.push(`      HDC_ROOT: /opt/hdc`);
  lines.push(`      HDC_PRIVATE_ROOT: /opt/hdc-private`);
  lines.push(`      HDC_AGENTS_META_ROOT: /opt/hdc-agents-meta`);
  lines.push(`      HDC_WEB_META_ROOT: /opt/hdc-agents-meta`);
  lines.push(`      HDC_WEB_UI_SESSION_SECRET: \${HDC_WEB_UI_SESSION_SECRET:-}`);
  lines.push(`      HDC_WEB_API_TOKEN: \${HDC_WEB_API_TOKEN:-}`);
  lines.push(`      HDC_WEB_OIDC_ISSUER: \${HDC_WEB_OIDC_ISSUER:-}`);
  lines.push(`      HDC_WEB_OIDC_CLIENT_ID: \${HDC_WEB_OIDC_CLIENT_ID:-}`);
  lines.push(`      HDC_WEB_OIDC_CLIENT_SECRET: \${HDC_WEB_OIDC_CLIENT_SECRET:-}`);
  lines.push(`      HDC_WEB_PUBLIC_URL: \${HDC_WEB_PUBLIC_URL:-}`);
  lines.push(`      HDC_WEB_ADMIN_PASSWORD: \${HDC_WEB_ADMIN_PASSWORD:-}`);
  lines.push(`    volumes:`);
  lines.push(`      - /opt/hdc-private:/opt/hdc-private:rw`);
  lines.push(`      - /opt/hdc-agents-meta:/opt/hdc-agents-meta:rw`);

  const augmentation = hdcAgents.augmentation && typeof hdcAgents.augmentation === "object"
    ? /** @type {Record<string, unknown>} */ (hdcAgents.augmentation)
    : null;
  const sidecars = Array.isArray(augmentation?.sidecars)
    ? /** @type {string[]} */ (augmentation.sidecars).map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (augmentation?.enabled !== false && sidecars.includes("cursor-cloud-bridge")) {
    const cloudCfg =
      augmentation.cursor_cloud && typeof augmentation.cursor_cloud === "object"
        ? /** @type {Record<string, unknown>} */ (augmentation.cursor_cloud)
        : {};
    const bridgeName =
      typeof cloudCfg.bridge_name === "string" && cloudCfg.bridge_name.trim()
        ? cloudCfg.bridge_name.trim()
        : "cursor-cloud-bridge";
    const bridgePort =
      typeof cloudCfg.port === "number" && Number.isFinite(cloudCfg.port)
        ? Math.floor(cloudCfg.port)
        : AUGMENT_SIDECAR_PORT;
    lines.push(`  ${bridgeName}:`);
    lines.push(`    container_name: ${bridgeName}`);
    if (systemId) lines.push(`    hostname: ${JSON.stringify(systemId)}`);
    lines.push(`    image: ${image}`);
    lines.push(`    build:`);
    lines.push(`      context: ${dir}`);
    lines.push(`      dockerfile: Dockerfile`);
    lines.push(`    restart: unless-stopped`);
    lines.push(`    env_file:`);
    lines.push(`      - ${dir}/.env`);
    lines.push(`    command: ["node", "apps/hdc-augment-bridge/server.mjs"]`);
    lines.push(`    ports:`);
    lines.push(`      - "${bridgePort}:${bridgePort}/tcp"`);
    lines.push(`    environment:`);
    pushSystemEnv(lines, "augment-bridge");
    lines.push(`      HDC_AUGMENT_BRIDGE_NAME: ${bridgeName}`);
    lines.push(`      HDC_AUGMENT_RUNTIME: cursor-cloud`);
    lines.push(`      HDC_AUGMENT_BRIDGE_PORT: "${bridgePort}"`);
    lines.push(`      HDC_AUGMENT_BRIDGE_TOKEN: \${HDC_AUGMENT_BRIDGE_TOKEN:-}`);
    lines.push(`      HDC_CURSOR_CLOUD_API_KEY: \${HDC_CURSOR_CLOUD_API_KEY:-}`);
    lines.push(`      HDC_AUGMENT_REPOSITORY_URL: \${HDC_AUGMENT_REPOSITORY_URL:-}`);
    lines.push(`      HDC_AUGMENT_REPOSITORY_REF: \${HDC_AUGMENT_REPOSITORY_REF:-main}`);
    const repos = Array.isArray(cloudCfg.repos) ? cloudCfg.repos.join(",") : "hdc-clumps";
    const deleg =
      Array.isArray(cloudCfg.delegatable_by)
        ? cloudCfg.delegatable_by.join(",")
        : "hdc-sre-engineer,hdc-qa,hdc-research,hdc-security-expert,hdc-security-architect,hdc-network-architect";
    lines.push(`      HDC_AUGMENT_REPOS: '${String(repos).replace(/'/g, "''")}'`);
    lines.push(`      HDC_AUGMENT_DELEGATABLE_BY: '${String(deleg).replace(/'/g, "''")}'`);
    lines.push(`    volumes:`);
    lines.push(`      - /opt/hdc-private:/opt/hdc-private:ro`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * LiteLLM agent registration entries for gateway upsert.
 * @param {string} guestIp
 * @param {Record<string, unknown>} hdcAgents
 */
export function litellmA2aAgentEntries(guestIp, hdcAgents) {
  const ip = String(guestIp || "").trim();
  if (!ip) return [];
  /** @type {Record<string, unknown>[]} */
  const entries = enabledAgents(hdcAgents).map(({ role, port }) => ({
    name: role,
    url: `http://${ip}:${port}`,
    card_name: role,
    description: formatA2aAgentDescription({
      name: role,
      description: `HDC container agent ${role}`,
      kind: "fleet",
    }),
    protocol_version: "0.3",
    kind: "fleet",
  }));

  const augmentation = hdcAgents.augmentation && typeof hdcAgents.augmentation === "object"
    ? /** @type {Record<string, unknown>} */ (hdcAgents.augmentation)
    : null;
  const sidecars = Array.isArray(augmentation?.sidecars)
    ? /** @type {string[]} */ (augmentation.sidecars).map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (augmentation?.enabled !== false && sidecars.includes("cursor-cloud-bridge")) {
    const cloudCfg =
      augmentation.cursor_cloud && typeof augmentation.cursor_cloud === "object"
        ? /** @type {Record<string, unknown>} */ (augmentation.cursor_cloud)
        : {};
    const bridgeName =
      typeof cloudCfg.bridge_name === "string" && cloudCfg.bridge_name.trim()
        ? cloudCfg.bridge_name.trim()
        : "cursor-cloud-bridge";
    const bridgePort =
      typeof cloudCfg.port === "number" && Number.isFinite(cloudCfg.port)
        ? Math.floor(cloudCfg.port)
        : AUGMENT_SIDECAR_PORT;
    entries.push({
      name: bridgeName,
      url: `http://${ip}:${bridgePort}`,
      card_name: bridgeName,
      description: formatA2aAgentDescription({
        name: bridgeName,
        description: "Cursor Cloud augmentor (hdc-agents sidecar)",
        kind: "augmentor",
        runtime: "cursor-cloud",
        repos: Array.isArray(cloudCfg.repos) ? cloudCfg.repos : ["hdc-clumps"],
        delegatable_by: Array.isArray(cloudCfg.delegatable_by)
          ? cloudCfg.delegatable_by
          : [
              "hdc-sre-engineer",
              "hdc-qa",
              "hdc-research",
              "hdc-security-expert",
              "hdc-security-architect",
              "hdc-network-architect",
            ],
      }),
      protocol_version: "0.3",
      kind: "augmentor",
      runtime: "cursor-cloud",
      repos: Array.isArray(cloudCfg.repos) ? cloudCfg.repos : ["hdc-clumps"],
      delegatable_by: Array.isArray(cloudCfg.delegatable_by)
        ? cloudCfg.delegatable_by
        : [
            "hdc-sre-engineer",
            "hdc-qa",
            "hdc-research",
            "hdc-security-expert",
            "hdc-security-architect",
            "hdc-network-architect",
          ],
    });
  }

  return entries;
}

/**
 * @param {Record<string, unknown>} hdcAgents
 * @returns {URL | null}
 */
export function parsePublicUrl(hdcAgents) {
  const raw = hdcAgents.public_url;
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  return new URL(s);
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} hdcAgents
 */
export function resolveUpstreamUrl(ctIp, hdcAgents) {
  const agents = enabledAgents(hdcAgents);
  const mgr = agents.find((a) => a.role === "hdc-manager") ?? agents[0];
  if (ctIp && mgr) return `http://${ctIp}:${mgr.port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} hdcAgents
 */
export function resolveWebUrl(ctIp, hdcAgents) {
  try {
    const pub = parsePublicUrl(hdcAgents);
    if (pub) return pub.toString();
  } catch {
    /* ignore */
  }
  if (ctIp) return `http://${ctIp}:9120`;
  return resolveUpstreamUrl(ctIp, hdcAgents);
}

/** Manager listen port (health check for agents). Web UI is 9120. */
export function hostPort(hdcAgents) {
  const agents = enabledAgents(hdcAgents);
  return agents.find((a) => a.role === "hdc-manager")?.port ?? 9200;
}

export function webHostPort() {
  return 9120;
}
