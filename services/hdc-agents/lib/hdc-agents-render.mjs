/** Agent roster: role id → host port on hdc-agents LXC. */
export const AGENT_ROSTER = [
  { role: "hdc-manager", port: 9200 },
  { role: "hdc-monitor", port: 9201 },
  { role: "hdc-sre", port: 9202 },
  { role: "hdc-security-expert", port: 9203 },
  { role: "hdc-security-architect", port: 9204 },
  { role: "hdc-network-architect", port: 9205 },
  { role: "hdc-research", port: 9206 },
  { role: "hdc-engineer", port: 9207 },
];

/** Roles that write digests/tasks under operations/ */
export const RW_OPERATIONS_ROLES = new Set([
  "hdc-manager",
  "hdc-monitor",
  "hdc-security-expert",
  "hdc-research",
  "hdc-sre",
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
  return u || "http://10.0.0.116:4000";
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
WORKDIR /opt/hdc/apps/hdc-mcp-server
RUN npm install --omit=dev --no-fund --no-audit || true
WORKDIR /opt/hdc/apps/hdc-web-server
RUN npm install --omit=dev --no-fund --no-audit || true
RUN npm run build || true
ENV HDC_ROOT=/opt/hdc
ENV NODE_ENV=production
WORKDIR /opt/hdc
EXPOSE 9120 9200
CMD ["node", "apps/hdc-agent-server/server.mjs"]
`;
}

/**
 * @param {Record<string, unknown>} hdcAgents
 * @param {Record<string, unknown>} install
 * @param {{ guestIp?: string | null }} [opts]
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

  /** @type {string[]} */
  const lines = ["services:"];
  for (const { role, port } of agents) {
    const svc = role.replace(/_/g, "-");
    const opsMode = RW_OPERATIONS_ROLES.has(role) ? "rw" : "ro";
    const keyEnv = `HDC_AGENT_LITELLM_KEY_${role.replace(/-/g, "_").toUpperCase()}`;
    lines.push(`  ${svc}:`);
    lines.push(`    container_name: ${svc}`);
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
    if (role === "hdc-engineer") {
      lines.push(`      - /opt/hdc-src:/opt/hdc:rw`);
    }
  }

  // CLI job scheduler (no LiteLLM)
  lines.push(`  hdc-scheduler:`);
  lines.push(`    container_name: hdc-scheduler`);
  lines.push(`    image: ${image}`);
  lines.push(`    build:`);
  lines.push(`      context: ${dir}`);
  lines.push(`      dockerfile: Dockerfile`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    env_file:`);
  lines.push(`      - ${dir}/.env`);
  lines.push(`    command: ["node", "apps/hdc-agent-server/bin/scheduler.mjs"]`);
  lines.push(`    environment:`);
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
  lines.push(`    volumes:`);
  lines.push(`      - /opt/hdc-private:/opt/hdc-private:rw`);
  lines.push(`      - /opt/hdc-agents-meta:/opt/hdc-agents-meta:rw`);

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
  return enabledAgents(hdcAgents).map(({ role, port }) => ({
    name: role,
    url: `http://${ip}:${port}`,
    card_name: role,
    description: `HDC container agent ${role}`,
    protocol_version: "0.3",
  }));
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
