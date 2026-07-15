import { describe, expect, it } from "vitest";

import { resolvePaperclipCompanyConfig } from "./paperclip-company-bootstrap.mjs";

describe("paperclip-company-bootstrap", () => {
  it("resolvePaperclipCompanyConfig reads company block", () => {
    const cfg = {
      defaults: {
        paperclip: {
          company: {
            name: "Home Data Center",
            api_url: "https://paperclip.example.test",
            hdc_web_url: "http://192.0.2.117:9120",
            skills_github_base: "https://github.com/dukk/hdc/tree/main/clumps/services/paperclip/skills",
            agents: [{ id: "hdc-monitor", name: "HDC Monitor", adapter_type: "cursor" }],
          },
        },
      },
    };
    const c = resolvePaperclipCompanyConfig(cfg);
    expect(c.name).toBe("Home Data Center");
    expect(c.api_url).toBe("https://paperclip.example.test");
    expect(c.skill_slugs).toContain("hdc-agent-team");
    expect(c.skill_slugs).not.toContain("hdc-runner");
    expect(c.agents).toHaveLength(1);
  });

  it("defaults company name when block missing", () => {
    const c = resolvePaperclipCompanyConfig({});
    expect(c.name).toBe("Home Data Center");
    expect(c.api_key_vault_key).toBe("HDC_PAPERCLIP_API_KEY");
  });
});
