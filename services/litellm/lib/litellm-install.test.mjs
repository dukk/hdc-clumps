import { describe, expect, it } from "vitest";

import {
  buildAlignDbPasswordScript,
  buildMaintainScript,
  parseOpenrouterApiKeyFromEnvText,
} from "./litellm-install.mjs";

describe("parseOpenrouterApiKeyFromEnvText", () => {
  it("reads an unquoted OPENROUTER_API_KEY", () => {
    expect(
      parseOpenrouterApiKeyFromEnvText("LITELLM_MASTER_KEY=sk-x\nOPENROUTER_API_KEY=or-secret\n"),
    ).toBe("or-secret");
  });

  it("strips surrounding quotes", () => {
    expect(parseOpenrouterApiKeyFromEnvText(`OPENROUTER_API_KEY="quoted-key"`)).toBe("quoted-key");
    expect(parseOpenrouterApiKeyFromEnvText("OPENROUTER_API_KEY='quoted-key'")).toBe("quoted-key");
  });

  it("returns null when missing or empty", () => {
    expect(parseOpenrouterApiKeyFromEnvText("LITELLM_MASTER_KEY=sk-x\n")).toBeNull();
    expect(parseOpenrouterApiKeyFromEnvText("OPENROUTER_API_KEY=\n")).toBeNull();
    expect(parseOpenrouterApiKeyFromEnvText("")).toBeNull();
  });
});

describe("buildMaintainScript", () => {
  it("includes volume wipe when resetVolumes is set", () => {
    const script = buildMaintainScript("/opt/litellm", "A=1\n", "model: x\n", { resetVolumes: true });
    expect(script).toContain("docker compose down -v || true");
  });

  it("skips pull when skipUpgrade is set", () => {
    const script = buildMaintainScript("/opt/litellm", "A=1\n", "model: x\n", { skipUpgrade: true });
    expect(script).not.toContain("docker compose pull");
    expect(script).toContain("docker compose up -d");
  });
});

describe("buildAlignDbPasswordScript", () => {
  it("ALTERs llmproxy and force-recreates litellm", () => {
    const script = buildAlignDbPasswordScript("/opt/litellm");
    expect(script).toContain("ALTER USER llmproxy");
    expect(script).toContain("docker compose up -d --force-recreate litellm");
  });
});
