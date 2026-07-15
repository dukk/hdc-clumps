import { describe, expect, it } from "vitest";

import { renderLitellmConfigYaml } from "./litellm-config-render.mjs";
import { normalizeModelList } from "./litellm-render.mjs";

const backends = {
  ollama: [
    { id: "ollama-a", url: "http://192.0.2.111:11434" },
    { id: "ollama-b", url: "http://192.0.2.112:11434" },
  ],
  openai: [{ id: "vllm-a", url: "http://192.0.2.25:8000/v1" }],
};

describe("litellm-config-render", () => {
  it("allows duplicate model_name for model groups", () => {
    const models = normalizeModelList(
      [
        {
          model_name: "lan-best-available",
          provider: "ollama",
          model: "qwen3:14b",
          ollama_backend_id: "ollama-a",
          order: 1,
        },
        {
          model_name: "lan-best-available",
          provider: "openai",
          model: "Qwen/Qwen3-8B",
          openai_backend_id: "vllm-a",
          order: 2,
        },
      ],
      backends,
    );
    expect(models).toHaveLength(2);
    expect(models[0].order).toBe(1);
    expect(models[1].order).toBe(2);
  });

  it("renders model group deployments with order and routing_groups", () => {
    const yaml = renderLitellmConfigYaml({
      ollama_backends: backends.ollama,
      openai_backends: backends.openai,
      model_list: [
        {
          model_name: "lan-best-available",
          provider: "ollama",
          model: "qwen3:14b",
          ollama_backend_id: "ollama-a",
          order: 1,
        },
        {
          model_name: "lan-best-available",
          provider: "openai",
          model: "Qwen/Qwen3-8B",
          openai_backend_id: "vllm-a",
          order: 2,
        },
      ],
      router_settings: {
        routing_strategy: "simple-shuffle",
        routing_groups: [
          {
            group_name: "lan-best-available",
            models: ["lan-best-available"],
            routing_strategy: "simple-shuffle",
          },
        ],
      },
    });

    expect(yaml).toContain("model_name: lan-best-available");
    expect(yaml.match(/model_name: lan-best-available/g)).toHaveLength(2);
    expect(yaml).toContain("model: ollama/qwen3:14b");
    expect(yaml).toContain("api_base: os.environ/OLLAMA_API_BASE_OLLAMA_A");
    expect(yaml).toContain("order: 1");
    expect(yaml).toContain("model: openai/Qwen/Qwen3-8B");
    expect(yaml).toContain("api_base: os.environ/OPENAI_API_BASE_VLLM_A");
    expect(yaml).toContain("order: 2");
    expect(yaml).toContain("routing_strategy: simple-shuffle");
    expect(yaml).toContain("routing_groups:");
    expect(yaml).toContain("group_name: lan-best-available");
    expect(yaml).toContain("- lan-best-available");
  });

  it("renders fallbacks alongside routing_groups", () => {
    const yaml = renderLitellmConfigYaml({
      ollama_backends: backends.ollama,
      model_list: [
        {
          model_name: "local-qwen",
          provider: "ollama",
          model: "qwen3.5:cloud",
          ollama_backend_id: "ollama-a",
        },
      ],
      router_settings: {
        routing_strategy: "simple-shuffle",
        fallbacks: [{ "local-qwen": ["claude-sonnet"] }],
      },
    });

    expect(yaml).toContain("fallbacks:");
    expect(yaml).toContain('- local-qwen: ["claude-sonnet"]');
    expect(yaml).toContain("routing_strategy: simple-shuffle");
  });

  it("renders auto_router complexity_router with tiers", () => {
    const yaml = renderLitellmConfigYaml({
      ollama_backends: backends.ollama,
      model_list: [
        {
          model_name: "local-qwen",
          provider: "ollama",
          model: "qwen3.5:cloud",
          ollama_backend_id: "ollama-a",
        },
        {
          model_name: "auto",
          provider: "auto_router",
          model: "complexity_router",
          complexity_router_default_model: "local-qwen",
          complexity_router_config: {
            tiers: {
              SIMPLE: "local-qwen",
              MEDIUM: "local-qwen",
              COMPLEX: "local-qwen",
              REASONING: "local-qwen",
            },
          },
        },
      ],
    });

    expect(yaml).toContain("model_name: auto");
    expect(yaml).toContain("model: auto_router/complexity_router");
    expect(yaml).toContain("complexity_router_config:");
    expect(yaml).toContain("SIMPLE: local-qwen");
    expect(yaml).toContain("complexity_router_default_model: local-qwen");
  });

  it("injects smtp_email callback and email alerts when mail.enabled", () => {
    const yaml = renderLitellmConfigYaml({
      ollama_backends: backends.ollama,
      model_list: [
        {
          model_name: "local-qwen",
          provider: "ollama",
          model: "qwen3.5:cloud",
          ollama_backend_id: "ollama-a",
        },
      ],
      litellm_settings: { drop_params: true },
      mail: { enabled: true, from: "litellm@hdc.dukk.org" },
    });

    expect(yaml).toContain("litellm_settings:");
    expect(yaml).toContain("callbacks:");
    expect(yaml).toContain("- smtp_email");
    expect(yaml).toContain("drop_params: true");
    expect(yaml).toContain("alerts:");
    expect(yaml).toContain("- email");
  });

  it("renders a2a_agents as LiteLLM agents section", () => {
    const yaml = renderLitellmConfigYaml({
      ollama_backends: backends.ollama,
      model_list: [
        {
          model_name: "local-qwen",
          provider: "ollama",
          model: "qwen3:14b",
          ollama_backend_id: "ollama-a",
        },
      ],
      a2a_agents: [
        {
          name: "hdc-manager",
          url: "http://192.0.2.117:9200",
          description: "HDC manager agent (hdc-agents fleet)",
          card_name: "hdc-manager",
          protocol_version: "0.3",
        },
      ],
    });

    expect(yaml).toContain("agents:");
    expect(yaml).toContain("agent_name: hdc-manager");
    expect(yaml).toContain("name: hdc-manager");
    expect(yaml).toContain("url: http://192.0.2.117:9200");
    expect(yaml).toContain("protocolVersion: \"0.3\"");
    expect(yaml).toContain('description: "HDC manager agent (hdc-agents fleet)"');
  });
});
