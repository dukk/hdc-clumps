import { describe, expect, it } from "vitest";

import {
  applicationPassesFilter,
  appsNeedUpdate,
  liveAppToNormalized,
  normalizeAzureConfig,
  normalizeRedirectUris,
  normalizeRequiredResourceAccess,
  resourceAccessEqual,
  suggestedConfigEntry,
} from "./azure-config.mjs";

describe("azure-config", () => {
  it("normalizes redirect URIs sorted and deduped", () => {
    expect(normalizeRedirectUris(["https://b/", "https://a", "https://a"])).toEqual([
      "https://a",
      "https://b/",
    ]);
  });

  it("normalizes required resource access from snake_case config", () => {
    const ra = normalizeRequiredResourceAccess([
      {
        resource_app_id: "00000003-0000-0000-c000-000000000000",
        resource_access: [{ id: "e1fe6dd8-ba31-4d61-89e7-88639da4683d", type: "Scope" }],
      },
    ]);
    expect(ra).toHaveLength(1);
    expect(ra[0].resource_app_id).toBe("00000003-0000-0000-c000-000000000000");
    expect(resourceAccessEqual(ra, ra)).toBe(true);
  });

  it("application filter modes", () => {
    const prefixes = ["HDC "];
    expect(applicationPassesFilter("HDC Portal", { mode: "all", prefixes: [] })).toBe(true);
    expect(applicationPassesFilter("Other", { mode: "include", prefixes })).toBe(false);
    expect(applicationPassesFilter("HDC Portal", { mode: "include", prefixes })).toBe(true);
    expect(applicationPassesFilter("HDC Portal", { mode: "exclude", prefixes })).toBe(false);
  });

  it("parses managed applications from config", () => {
    const cfg = normalizeAzureConfig({
      schema_version: 1,
      applications: [
        {
          id: "app-a",
          managed: true,
          display_name: "App A",
          match: { display_name: "App A" },
          sign_in_audience: "AzureADMyOrg",
          web: { redirect_uris: [] },
          spa: { redirect_uris: [] },
          public_client: { redirect_uris: [] },
        },
        {
          id: "app-b",
          managed: false,
          display_name: "App B",
          match: { display_name: "App B" },
        },
      ],
    });
    expect(cfg.managedApplications).toHaveLength(1);
    expect(cfg.managedApplications[0].id).toBe("app-a");
  });

  it("accepts legacy azure_entra config key", () => {
    const cfg = normalizeAzureConfig({
      schema_version: 1,
      azure_entra: { graph_base_url: "https://graph.microsoft.com/v1.0" },
      applications: [],
    });
    expect(cfg.graphBase).toBe("https://graph.microsoft.com/v1.0");
  });

  it("normalizes schema v2 entra section", () => {
    const cfg = normalizeAzureConfig({
      schema_version: 2,
      entra: {
        graph_base_url: "https://graph.microsoft.com/v1.0/",
        automation: { app_id: "hdc" },
        application_filter: { mode: "all", display_name_prefixes: [] },
        applications: [
          {
            id: "app-a",
            managed: true,
            display_name: "App A",
            match: { display_name: "App A" },
          },
        ],
      },
      compute: { defaults: {}, deployments: [] },
    });
    expect(cfg.schema_version).toBe(2);
    expect(cfg.graphBase).toBe("https://graph.microsoft.com/v1.0");
    expect(cfg.managedApplications).toHaveLength(1);
    expect(cfg.applications[0].id).toBe("app-a");
    expect(cfg.automation.app_id).toBe("hdc");
    expect(cfg.automation.application_id_env).toBe("HDC_AZURE_ENTRA_HDC_APPLICATION_ID");
    expect(cfg.automation.secret_value_vault_key).toBe("HDC_AZURE_ENTRA_HDC_SECRET_VALUE");
    expect(cfg.automation.secret_id_env).toBe("HDC_AZURE_ENTRA_HDC_SECRET_ID");
  });

  it("defaults entra.automation.app_id to hdc", () => {
    const cfg = normalizeAzureConfig({ schema_version: 2, entra: { applications: [] } });
    expect(cfg.automation.app_id).toBe("hdc");
  });

  it("detects drift on redirect URIs", () => {
    const live = liveAppToNormalized({
      id: "obj-1",
      appId: "client-1",
      displayName: "Test",
      signInAudience: "AzureADMyOrg",
      web: { redirectUris: ["https://old.example/cb"] },
      spa: { redirectUris: [] },
      publicClient: { redirectUris: [] },
      requiredResourceAccess: [],
      identifierUris: [],
    });
    const desired = {
      ...live,
      web: { redirect_uris: ["https://new.example/cb"] },
      spa: live.spa,
      public_client: live.public_client,
      required_resource_access: live.required_resource_access,
      identifier_uris: live.identifier_uris,
    };
    expect(appsNeedUpdate(desired, live)).toBe(true);
  });

  it("builds suggested config entry with client_id", () => {
    const live = liveAppToNormalized({
      id: "obj-1",
      appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      displayName: "My App",
      signInAudience: "AzureADMyOrg",
      web: { redirectUris: ["https://app/cb"] },
      spa: { redirectUris: [] },
      publicClient: { redirectUris: [] },
      requiredResourceAccess: [],
    });
    const entry = suggestedConfigEntry(live);
    expect(entry.managed).toBe(false);
    expect(entry.match.client_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(entry.web.redirect_uris).toEqual(["https://app/cb"]);
  });
});
