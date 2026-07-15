import { mailBlockFromService } from "hdc/package/app-mail-render.mjs";
import { mailEnabledFromConfig } from "hdc/package/mail-relay-settings.mjs";
import {
  normalizeBackends,
  normalizeModelList,
  ollamaBackendEnvVar,
  openaiBackendEnvVar,
} from "./litellm-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} s
 */
function yamlQuote(s) {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {number} indent
 */
function yamlLine(key, value, indent = 0) {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return `${pad}${key}: ${value ? "true" : "false"}`;
  if (typeof value === "number" && Number.isFinite(value)) return `${pad}${key}: ${value}`;
  return `${pad}${key}: ${yamlQuote(String(value))}`;
}

/**
 * @param {unknown} value
 * @param {number} indent
 * @returns {string[]}
 */
function renderYamlValue(value, indent) {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return [];
  if (typeof value === "boolean") return [`${pad}${value ? "true" : "false"}`];
  if (typeof value === "number" && Number.isFinite(value)) return [`${pad}${value}`];
  if (typeof value === "string") return [`${pad}${yamlQuote(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    /** @type {string[]} */
    const lines = [];
    for (const item of value) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        lines.push(`${pad}- ${yamlQuote(String(item))}`);
      } else if (isObject(item)) {
        lines.push(`${pad}-`);
        lines.push(...renderYamlObject(item, indent + 2));
      }
    }
    return lines;
  }
  if (isObject(value)) {
    return renderYamlObject(value, indent);
  }
  return [`${pad}${yamlQuote(String(value))}`];
}

/**
 * @param {Record<string, unknown>} obj
 * @param {number} indent
 * @returns {string[]}
 */
function renderYamlObject(obj, indent) {
  /** @type {string[]} */
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (Array.isArray(val) || isObject(val)) {
      lines.push(`${" ".repeat(indent)}${key}:`);
      lines.push(...renderYamlValue(val, indent + 2));
    } else {
      lines.push(yamlLine(key, val, indent));
    }
  }
  return lines;
}

/**
 * @param {unknown} fallbacks
 * @returns {string[]}
 */
function renderFallbacksYaml(fallbacks) {
  if (!Array.isArray(fallbacks) || fallbacks.length === 0) return [];
  /** @type {string[]} */
  const lines = ["  fallbacks:"];
  for (const item of fallbacks) {
    if (!isObject(item)) continue;
    for (const [from, toList] of Object.entries(item)) {
      if (Array.isArray(toList)) {
        lines.push(`    - ${from}: ${JSON.stringify(toList)}`);
      }
    }
  }
  return lines.length > 1 ? lines : [];
}

/**
 * @param {unknown} routingGroups
 * @returns {string[]}
 */
function renderRoutingGroupsYaml(routingGroups) {
  if (!Array.isArray(routingGroups) || routingGroups.length === 0) return [];
  /** @type {string[]} */
  const lines = ["  routing_groups:"];
  for (const group of routingGroups) {
    if (!isObject(group)) continue;
    lines.push("    -");
    if (typeof group.group_name === "string" && group.group_name.trim()) {
      lines.push(yamlLine("group_name", group.group_name.trim(), 6));
    }
    if (Array.isArray(group.models) && group.models.length > 0) {
      lines.push("      models:");
      for (const model of group.models) {
        if (typeof model === "string" && model.trim()) {
          lines.push(`        - ${yamlQuote(model.trim())}`);
        }
      }
    }
    if (typeof group.routing_strategy === "string" && group.routing_strategy.trim()) {
      lines.push(yamlLine("routing_strategy", group.routing_strategy.trim(), 6));
    }
    if (isObject(group.routing_strategy_args) && Object.keys(group.routing_strategy_args).length > 0) {
      lines.push("      routing_strategy_args:");
      lines.push(...renderYamlObject(group.routing_strategy_args, 8));
    }
  }
  return lines.length > 1 ? lines : [];
}

/**
 * @param {Record<string, unknown>} routerSettings
 * @returns {string[]}
 */
function renderRouterSettingsYaml(routerSettings) {
  const fallbackLines = renderFallbacksYaml(routerSettings.fallbacks);
  const routingGroupLines = renderRoutingGroupsYaml(routerSettings.routing_groups);
  const hasRoutingStrategy =
    typeof routerSettings.routing_strategy === "string" && routerSettings.routing_strategy.trim();
  const hasRoutingStrategyArgs =
    isObject(routerSettings.routing_strategy_args) &&
    Object.keys(routerSettings.routing_strategy_args).length > 0;

  if (
    fallbackLines.length === 0 &&
    routingGroupLines.length === 0 &&
    !hasRoutingStrategy &&
    !hasRoutingStrategyArgs
  ) {
    return [];
  }

  /** @type {string[]} */
  const lines = ["router_settings:"];
  if (hasRoutingStrategy) {
    lines.push(yamlLine("routing_strategy", routerSettings.routing_strategy, 2));
  }
  if (hasRoutingStrategyArgs) {
    lines.push("  routing_strategy_args:");
    lines.push(...renderYamlObject(routerSettings.routing_strategy_args, 4));
  }
  if (routingGroupLines.length > 0) {
    lines.push(...routingGroupLines);
  }
  if (fallbackLines.length > 0) {
    lines.push(...fallbackLines);
  }
  return lines;
}

/**
 * @param {unknown} agents
 * @returns {string[]}
 */
export function renderA2aAgentsYaml(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return [];
  /** @type {string[]} */
  const lines = ["agents:"];
  for (const agent of agents) {
    if (!isObject(agent)) continue;
    const name = typeof agent.name === "string" ? agent.name.trim() : "";
    const url = typeof agent.url === "string" ? agent.url.trim() : "";
    if (!name || !url) continue;
    const cardName =
      typeof agent.card_name === "string" && agent.card_name.trim()
        ? agent.card_name.trim()
        : name;
    const protocol =
      typeof agent.protocol_version === "string" && agent.protocol_version.trim()
        ? agent.protocol_version.trim()
        : "0.3";
    lines.push("  -");
    lines.push(yamlLine("agent_name", name, 4));
    lines.push("    agent_card_params:");
    lines.push(yamlLine("name", cardName, 6));
    lines.push(yamlLine("url", url, 6));
    // Force quotes so YAML keeps protocolVersion as a string (0.3 must not become a float).
    lines.push(`${" ".repeat(6)}protocolVersion: ${JSON.stringify(protocol)}`);
    if (typeof agent.description === "string" && agent.description.trim()) {
      lines.push(yamlLine("description", agent.description.trim(), 6));
    }
  }
  return lines.length > 1 ? lines : [];
}

/**
 * @param {Record<string, unknown>} litellm
 */
export function renderLitellmConfigYaml(litellm) {
  const cfg = isObject(litellm) ? litellm : {};
  const backends = normalizeBackends(cfg);
  const models = normalizeModelList(cfg.model_list, backends);

  /** @type {string[]} */
  const lines = ["# hdc-generated — LiteLLM config.yaml", "model_list:"];

  for (const entry of models) {
    lines.push("  -");
    lines.push(yamlLine("model_name", entry.model_name, 4));
    lines.push("    litellm_params:");
    if (entry.provider === "ollama") {
      lines.push(yamlLine("model", `ollama/${entry.model}`, 6));
      const backendId = entry.ollama_backend_id ?? backends.ollama[0]?.id;
      if (backendId) {
        lines.push(yamlLine("api_base", `os.environ/${ollamaBackendEnvVar(backendId)}`, 6));
      }
    } else if (entry.provider === "openai") {
      lines.push(yamlLine("model", `openai/${entry.model}`, 6));
      const backendId = entry.openai_backend_id ?? backends.openai[0]?.id;
      if (backendId) {
        lines.push(yamlLine("api_base", `os.environ/${openaiBackendEnvVar(backendId)}`, 6));
      }
      // vLLM has no auth; LiteLLM still expects a key field for openai/* — use a placeholder
      lines.push(yamlLine("api_key", "EMPTY", 6));
    } else if (entry.provider === "openrouter") {
      lines.push(yamlLine("model", `openrouter/${entry.model}`, 6));
      lines.push(yamlLine("api_key", "os.environ/OPENROUTER_API_KEY", 6));
    } else if (entry.provider === "auto_router") {
      lines.push(yamlLine("model", `auto_router/${entry.model}`, 6));
      if (entry.complexity_router_config && Object.keys(entry.complexity_router_config).length > 0) {
        lines.push("      complexity_router_config:");
        lines.push(...renderYamlObject(entry.complexity_router_config, 8));
      }
      if (entry.complexity_router_default_model) {
        lines.push(yamlLine("complexity_router_default_model", entry.complexity_router_default_model, 6));
      }
    }
    if (entry.order !== undefined) {
      lines.push(yamlLine("order", entry.order, 6));
    }
    if (entry.weight !== undefined) {
      lines.push(yamlLine("weight", entry.weight, 6));
    }
  }

  /** @type {Record<string, unknown>} */
  const litellmSettings = {
    ...(isObject(cfg.litellm_settings) ? /** @type {Record<string, unknown>} */ (cfg.litellm_settings) : {}),
  };
  const mailEnabled = mailEnabledFromConfig(mailBlockFromService(cfg));
  if (mailEnabled) {
    const existing = Array.isArray(litellmSettings.callbacks) ? litellmSettings.callbacks : [];
    /** @type {unknown[]} */
    const callbacks = [...existing];
    if (!callbacks.includes("smtp_email")) callbacks.push("smtp_email");
    litellmSettings.callbacks = callbacks;
  }
  if (Object.keys(litellmSettings).length > 0) {
    lines.push("litellm_settings:");
    lines.push(...renderYamlObject(litellmSettings, 2));
  }

  const routerSettings = isObject(cfg.router_settings) ? cfg.router_settings : {};
  const routerLines = renderRouterSettingsYaml(routerSettings);
  if (routerLines.length > 0) {
    lines.push(...routerLines);
  }

  const a2aLines = renderA2aAgentsYaml(cfg.a2a_agents);
  if (a2aLines.length > 0) {
    lines.push(...a2aLines);
  }

  lines.push("general_settings:");
  lines.push(yamlLine("master_key", "os.environ/LITELLM_MASTER_KEY", 2));
  lines.push(yamlLine("database_url", "os.environ/DATABASE_URL", 2));
  if (mailEnabled) {
    /** @type {unknown[]} */
    const alerts = [];
    const gs = isObject(cfg.general_settings)
      ? /** @type {Record<string, unknown>} */ (cfg.general_settings)
      : {};
    if (Array.isArray(gs.alerts)) {
      for (const a of gs.alerts) alerts.push(a);
    }
    if (!alerts.includes("email")) alerts.push("email");
    lines.push("  alerts:");
    for (const a of alerts) {
      lines.push(`    - ${yamlQuote(String(a))}`);
    }
  }

  return `${lines.filter(Boolean).join("\n")}\n`;
}
