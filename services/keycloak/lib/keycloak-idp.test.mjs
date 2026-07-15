import { describe, expect, it } from "vitest";

import {
  identityProviderNeedsUpdate,
  identityProviderRepresentationFromConfig,
} from "./keycloak-api.mjs";
import { normalizeRealmIdentityProvider } from "./keycloak-realms.mjs";

describe("normalizeRealmIdentityProvider", () => {
  it("requires alias, provider_id, client_id, and client_secret_vault_key", () => {
    expect(() => normalizeRealmIdentityProvider({})).toThrow(/alias/);
    expect(() =>
      normalizeRealmIdentityProvider({ alias: "microsoft", provider_id: "microsoft" }),
    ).toThrow(/client_id/);
    expect(() =>
      normalizeRealmIdentityProvider({
        alias: "microsoft",
        provider_id: "microsoft",
        client_id: "abc",
      }),
    ).toThrow(/client_secret_vault_key/);
  });

  it("normalizes Microsoft IdP defaults", () => {
    const idp = normalizeRealmIdentityProvider({
      alias: "microsoft",
      provider_id: "microsoft",
      client_id: "00000000-0000-0000-0000-000000000001",
      client_secret_vault_key: "HDC_KEYCLOAK_IDP_MICROSOFT_CLIENT_SECRET",
      display_name: "Microsoft",
      trust_email: true,
      sync_mode: "import",
      default_scope: "openid profile email",
    });
    expect(idp.alias).toBe("microsoft");
    expect(idp.provider_id).toBe("microsoft");
    expect(idp.sync_mode).toBe("IMPORT");
    expect(idp.trust_email).toBe(true);
  });
});

describe("identityProviderRepresentationFromConfig", () => {
  const cfg = {
    alias: "microsoft",
    provider_id: "microsoft",
    enabled: true,
    display_name: "Microsoft",
    trust_email: true,
    client_id: "app-id",
    client_secret_vault_key: "HDC_KEYCLOAK_IDP_MICROSOFT_CLIENT_SECRET",
    sync_mode: "IMPORT",
    default_scope: "openid profile email",
  };

  it("builds representation with secret on create", () => {
    const rep = identityProviderRepresentationFromConfig(cfg, null, {
      clientSecret: "s3cret",
    });
    expect(rep.alias).toBe("microsoft");
    expect(rep.providerId).toBe("microsoft");
    expect(rep.trustEmail).toBe(true);
    expect(rep.firstBrokerLoginFlowAlias).toBe("first broker login");
    expect(rep.config).toMatchObject({
      clientId: "app-id",
      clientSecret: "s3cret",
      syncMode: "IMPORT",
      defaultScope: "openid profile email",
    });
  });

  it("omits clientSecret on update when not rotating", () => {
    const live = {
      alias: "microsoft",
      providerId: "microsoft",
      enabled: true,
      displayName: "Microsoft",
      trustEmail: true,
      storeToken: false,
      linkOnly: false,
      firstBrokerLoginFlowAlias: "first broker login",
      config: {
        clientId: "old-id",
        clientSecret: "**********",
        syncMode: "IMPORT",
        defaultScope: "openid profile email",
      },
    };
    const rep = identityProviderRepresentationFromConfig(cfg, live, {});
    expect(rep.config.clientId).toBe("app-id");
    expect(rep.config.clientSecret).toBeUndefined();
  });

  it("detects drift on clientId without comparing secrets", () => {
    const live = {
      alias: "microsoft",
      providerId: "microsoft",
      enabled: true,
      displayName: "Microsoft",
      trustEmail: true,
      storeToken: false,
      linkOnly: false,
      firstBrokerLoginFlowAlias: "first broker login",
      config: {
        clientId: "other",
        clientSecret: "hidden",
        syncMode: "IMPORT",
        defaultScope: "openid profile email",
      },
    };
    expect(identityProviderNeedsUpdate(live, cfg)).toBe(true);
    live.config.clientId = "app-id";
    expect(identityProviderNeedsUpdate(live, cfg)).toBe(false);
  });
});
