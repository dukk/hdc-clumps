import { describe, expect, it } from "vitest";

import {
  entraAppEnvPrefix,
  resolveAzureAutomationKeys,
  resolveAzureClientId,
  resolveAzureSecretId,
  resolveAzureTenantId,
} from "./vault-deps.mjs";

describe("azure vault-deps env", () => {
  it("entraAppEnvPrefix uppercases and replaces hyphens", () => {
    expect(entraAppEnvPrefix("hdc")).toBe("HDC_AZURE_ENTRA_HDC");
    expect(entraAppEnvPrefix("keycloak-microsoft-idp")).toBe(
      "HDC_AZURE_ENTRA_KEYCLOAK_MICROSOFT_IDP"
    );
  });

  it("resolveAzureAutomationKeys defaults to hdc", () => {
    const keys = resolveAzureAutomationKeys(undefined);
    expect(keys.app_id).toBe("hdc");
    expect(keys.application_id_env).toBe("HDC_AZURE_ENTRA_HDC_APPLICATION_ID");
    expect(keys.secret_value_vault_key).toBe("HDC_AZURE_ENTRA_HDC_SECRET_VALUE");
    expect(keys.secret_id_env).toBe("HDC_AZURE_ENTRA_HDC_SECRET_ID");
  });

  it("prefers HDC_AZURE_ENTRA_<APP>_APPLICATION_ID over legacy CLIENT_ID", () => {
    const env = {
      HDC_AZURE_ENTRA_HDC_APPLICATION_ID: "real-app-id",
      HDC_AZURE_ENTRA_CLIENT_ID: "secret-id-misused",
      HDC_AZURE_CLIENT_ID: "legacy-client",
    };
    expect(resolveAzureClientId({ automation: { app_id: "hdc" } }, env)).toBe("real-app-id");
  });

  it("falls back to HDC_AZURE_ENTRA_CLIENT_ID then HDC_AZURE_CLIENT_ID", () => {
    expect(
      resolveAzureClientId(undefined, {
        HDC_AZURE_ENTRA_CLIENT_ID: "entra-client",
        HDC_AZURE_CLIENT_ID: "legacy-client",
      })
    ).toBe("entra-client");
    expect(resolveAzureClientId(undefined, { HDC_AZURE_CLIENT_ID: "legacy-client" })).toBe(
      "legacy-client"
    );
  });

  it("supports legacy resolveAzureClientId(env) signature", () => {
    expect(
      resolveAzureClientId({
        HDC_AZURE_ENTRA_HDC_APPLICATION_ID: "from-legacy-sig",
      })
    ).toBe("from-legacy-sig");
  });

  it("resolveAzureSecretId is optional and never preferred as client id", () => {
    const env = {
      HDC_AZURE_ENTRA_HDC_APPLICATION_ID: "app-id",
      HDC_AZURE_ENTRA_HDC_SECRET_ID: "secret-id-only",
    };
    expect(resolveAzureClientId(undefined, env)).toBe("app-id");
    expect(resolveAzureSecretId(undefined, env)).toBe("secret-id-only");
    expect(resolveAzureSecretId(undefined, {})).toBe(null);
  });

  it("prefers HDC_AZURE_ENTRA_* tenant over legacy", () => {
    const env = {
      HDC_AZURE_ENTRA_TENANT_ID: "entra-tenant",
      HDC_AZURE_TENANT_ID: "legacy-tenant",
    };
    expect(resolveAzureTenantId(env)).toBe("entra-tenant");
  });

  it("falls back to legacy HDC_AZURE_TENANT_ID", () => {
    expect(resolveAzureTenantId({ HDC_AZURE_TENANT_ID: "legacy-tenant" })).toBe("legacy-tenant");
  });

  it("throws when tenant or application id missing", () => {
    expect(() => resolveAzureTenantId({})).toThrow(/HDC_AZURE_ENTRA_TENANT_ID/);
    expect(() => resolveAzureClientId(undefined, {})).toThrow(
      /HDC_AZURE_ENTRA_HDC_APPLICATION_ID/
    );
  });
});
