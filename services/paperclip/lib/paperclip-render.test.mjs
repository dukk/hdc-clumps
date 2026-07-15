import { describe, expect, it } from "vitest";

import {
  normalizeOllamaBackends,
  primaryOllamaBaseUrl,
  renderPaperclipEnv,
} from "./paperclip-render.mjs";

const basePaperclip = {
  image_tag: "latest",
  host_port: 3100,
  deployment_mode: "authenticated",
  deployment_exposure: "private",
  telemetry_disabled: true,
};

const baseSecrets = {
  betterAuthSecret: "auth-secret-value",
  dbPassword: "db-pass-value",
};

describe("paperclip-render", () => {
  it("renderPaperclipEnv emits OpenAI and Gemini keys with correct guest names", () => {
    const env = renderPaperclipEnv(basePaperclip, {
      ...baseSecrets,
      openaiApiKey: "sk-openai-test",
      googleGeminiApiKey: "gemini-key-test",
    });
    expect(env).toContain("OPENAI_API_KEY=sk-openai-test");
    expect(env).toContain("GOOGLE_API_KEY=gemini-key-test");
    expect(env).not.toContain("GOOGLE_GEMINI_API_KEY=");
    expect(env).not.toContain("HDC_PAPERCLIP_");
  });

  it("renderPaperclipEnv omits optional keys when empty", () => {
    const env = renderPaperclipEnv(basePaperclip, baseSecrets);
    expect(env).not.toContain("OPENAI_API_KEY=");
    expect(env).not.toContain("GOOGLE_API_KEY=");
    expect(env).not.toContain("OLLAMA_BASE_URL=");
  });

  it("renderPaperclipEnv sets OLLAMA_BASE_URL from primary backend", () => {
    const env = renderPaperclipEnv(
      {
        ...basePaperclip,
        ollama_backends: [
          { id: "ollama-a", url: "http://192.0.2.111:11434" },
          { id: "ollama-b", url: "http://192.0.2.112:11434", primary: true },
        ],
      },
      baseSecrets,
    );
    expect(env).toContain("OLLAMA_BASE_URL=http://192.0.2.112:11434");
  });

  it("primaryOllamaBaseUrl falls back to first entry when none marked primary", () => {
    const backends = normalizeOllamaBackends([
      { id: "ollama-a", url: "http://192.0.2.111:11434" },
      { id: "ollama-b", url: "http://192.0.2.112:11434" },
    ]);
    expect(primaryOllamaBaseUrl(backends)).toBe("http://192.0.2.111:11434");
  });

  it("normalizeOllamaBackends returns empty array when unset", () => {
    expect(normalizeOllamaBackends(undefined)).toEqual([]);
    expect(normalizeOllamaBackends([])).toEqual([]);
  });
});
