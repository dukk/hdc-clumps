import { describe, expect, it } from "vitest";

import { normalizeAzureConfig } from "./azure-config.mjs";
import { planAppSync } from "./azure-sync.mjs";

describe("planAppSync", () => {
  const cfg = normalizeAzureConfig({
    schema_version: 1,
    applications: [
      {
        id: "portal",
        managed: true,
        display_name: "Portal",
        match: { client_id: "11111111-1111-1111-1111-111111111111", display_name: "Portal" },
        sign_in_audience: "AzureADMyOrg",
        web: { redirect_uris: ["https://portal.example/cb"] },
        spa: { redirect_uris: [] },
        public_client: { redirect_uris: [] },
      },
    ],
  });
  const app = cfg.applicationsById.get("portal");

  it("plans create when live app is missing", () => {
    const plan = planAppSync({ configApp: app, live: null });
    expect(plan.action).toBe("create");
  });

  it("plans unchanged when live matches config", () => {
    const plan = planAppSync({
      configApp: app,
      live: {
        id: "obj-1",
        appId: "11111111-1111-1111-1111-111111111111",
        displayName: "Portal",
        signInAudience: "AzureADMyOrg",
        web: { redirectUris: ["https://portal.example/cb"] },
        spa: { redirectUris: [] },
        publicClient: { redirectUris: [] },
        requiredResourceAccess: [],
      },
    });
    expect(plan.action).toBe("unchanged");
  });

  it("plans update when redirect URI drifts", () => {
    const plan = planAppSync({
      configApp: app,
      live: {
        id: "obj-1",
        appId: "11111111-1111-1111-1111-111111111111",
        displayName: "Portal",
        signInAudience: "AzureADMyOrg",
        web: { redirectUris: ["https://other.example/cb"] },
        spa: { redirectUris: [] },
        publicClient: { redirectUris: [] },
        requiredResourceAccess: [],
      },
    });
    expect(plan.action).toBe("update");
    expect(plan.patch).toBeTruthy();
    expect(plan.patch?.web).toEqual({ redirectUris: ["https://portal.example/cb"] });
  });
});
