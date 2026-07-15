import { describe, expect, it } from "vitest";

import { liveAppsToConfigEntries } from "./azure-import.mjs";

describe("azure-import", () => {
  const filter = { mode: "all", prefixes: [] };

  it("builds track-only entries and skips automation client", () => {
    const apps = liveAppsToConfigEntries(
      [
        {
          id: "obj-auto",
          appId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          displayName: "HDC Automation",
          signInAudience: "AzureADMyOrg",
          web: { redirectUris: [] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          requiredResourceAccess: [],
        },
        {
          id: "obj-portal",
          appId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          displayName: "Portal App",
          signInAudience: "AzureADMyOrg",
          web: { redirectUris: ["https://portal/cb"] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          requiredResourceAccess: [],
        },
      ],
      filter,
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );

    expect(apps).toHaveLength(1);
    expect(apps[0].managed).toBe(false);
    expect(apps[0].match.client_id).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(apps[0].id).toBe("portal-app");
  });

  it("preserves id and managed when display name matches", () => {
    const apps = liveAppsToConfigEntries(
      [
        {
          id: "obj-1",
          appId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          displayName: "Keycloak Microsoft IdP (dukk-sso)",
          signInAudience: "AzureADandPersonalMicrosoftAccount",
          web: { redirectUris: ["https://example/cb"] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          requiredResourceAccess: [],
        },
      ],
      filter,
      "",
      [
        {
          id: "keycloak-microsoft-idp",
          managed: true,
          match: { display_name: "Keycloak Microsoft IdP (dukk-sso)" },
          display_name: "Keycloak Microsoft IdP (dukk-sso)",
          sign_in_audience: "AzureADandPersonalMicrosoftAccount",
          web: { redirect_uris: [] },
          spa: { redirect_uris: [] },
          public_client: { redirect_uris: [] },
          required_resource_access: [],
          identifier_uris: [],
        },
      ]
    );

    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe("keycloak-microsoft-idp");
    expect(apps[0].managed).toBe(true);
    expect(apps[0].match.client_id).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
  });

  it("prefers client_id match over display name", () => {
    const apps = liveAppsToConfigEntries(
      [
        {
          id: "obj-1",
          appId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          displayName: "Renamed Live",
          signInAudience: "AzureADMyOrg",
          web: { redirectUris: [] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          requiredResourceAccess: [],
        },
      ],
      filter,
      "",
      [
        {
          id: "stable-id",
          managed: true,
          match: {
            client_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
            display_name: "Old Name",
          },
          display_name: "Old Name",
          sign_in_audience: "AzureADMyOrg",
          web: { redirect_uris: [] },
          spa: { redirect_uris: [] },
          public_client: { redirect_uris: [] },
          required_resource_access: [],
          identifier_uris: [],
        },
      ]
    );

    expect(apps[0].id).toBe("stable-id");
    expect(apps[0].managed).toBe(true);
    expect(apps[0].display_name).toBe("Renamed Live");
  });

  it("dedupes config ids with client_id suffix", () => {
    const apps = liveAppsToConfigEntries(
      [
        {
          id: "obj-1",
          appId: "11111111-1111-1111-1111-111111111111",
          displayName: "Same Name",
          signInAudience: "AzureADMyOrg",
          web: { redirectUris: [] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          requiredResourceAccess: [],
        },
        {
          id: "obj-2",
          appId: "22222222-2222-2222-2222-222222222222",
          displayName: "Same Name",
          signInAudience: "AzureADMyOrg",
          web: { redirectUris: [] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          requiredResourceAccess: [],
        },
      ],
      filter,
      ""
    );

    expect(apps).toHaveLength(2);
    expect(apps[0].id).not.toBe(apps[1].id);
    expect(apps[1].id).toContain("22222222");
  });
});
