import { describe, expect, it } from "vitest";

import { normalizeUriList } from "./gcp-oauth-config.mjs";
import { diffApplication, uriSetDrift } from "./gcp-oauth-diff.mjs";
import { buildDerivedUris } from "./derive-redirect-uris.mjs";
import { parseImportJson } from "./gcp-oauth-import.mjs";
import { isAllowedRedirectUri, resolveEffectiveApplication } from "./gcp-oauth-validate.mjs";

describe("gcp-oauth-config", () => {
  it("normalizes and dedupes URI lists", () => {
    expect(normalizeUriList(["https://app/cb", "https://app/cb", ""])).toEqual(["https://app/cb"]);
  });
});

describe("buildDerivedUris", () => {
  it("builds https redirect and origin from hostname and path", () => {
    const d = buildDerivedUris("vault.home.example.invalid", "/oidc/callback");
    expect(d.redirect_uris).toEqual(["https://vault.home.example.invalid/oidc/callback"]);
    expect(d.javascript_origins).toEqual(["https://vault.home.example.invalid"]);
  });
});

describe("parseImportJson", () => {
  it("parses web client download JSON", () => {
    const clients = parseImportJson({
      web: {
        client_id: "123.apps.googleusercontent.com",
        client_secret: "GOCSPX-secret",
        redirect_uris: ["https://app/cb"],
        javascript_origins: ["https://app"],
      },
    });
    expect(clients).toHaveLength(1);
    expect(clients[0].client_id).toBe("123.apps.googleusercontent.com");
    expect(clients[0].redirect_uris).toEqual(["https://app/cb"]);
  });
});

describe("uriSetDrift", () => {
  it("detects missing and extra URIs", () => {
    const d = uriSetDrift(["https://a/cb"], ["https://b/cb", "https://a/cb"]);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual(["https://b/cb"]);
  });
});

describe("diffApplication", () => {
  it("flags client_id mismatch", () => {
    const d = diffApplication({
      desired: {
        redirect_uris: ["https://a/cb"],
        javascript_origins: ["https://a"],
        existing_client_id: "aaa.apps.googleusercontent.com",
      },
      live: {
        client_id: "bbb.apps.googleusercontent.com",
        redirect_uris: ["https://a/cb"],
        javascript_origins: ["https://a"],
      },
    });
    expect(d.client_id_mismatch).toBe(true);
    expect(d.has_drift).toBe(true);
  });
});

describe("resolveEffectiveApplication", () => {
  it("uses explicit redirect_uris when set", () => {
    const app = {
      id: "test",
      display_name: "Test",
      client_type: "web",
      redirect_uris: ["https://explicit/cb"],
      javascript_origins: ["https://explicit"],
      scopes: [],
      derive_from: null,
      vault: { client_id_key: "HDC_X", client_secret_key: "HDC_Y" },
      existing_client_id: null,
      import_match: null,
    };
    const eff = resolveEffectiveApplication(app);
    expect(eff.redirect_uris).toEqual(["https://explicit/cb"]);
  });
});

describe("isAllowedRedirectUri", () => {
  it("allows https and localhost http", () => {
    expect(isAllowedRedirectUri("https://app.example/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil/cb")).toBe(false);
  });
});
