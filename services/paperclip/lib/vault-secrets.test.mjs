import { describe, expect, it } from "vitest";

import { resolvePaperclipSecretsForMaintain } from "./vault-secrets.mjs";

/**
 * @param {Record<string, string>} initial
 */
function mockVault(initial = {}) {
  /** @type {Record<string, string>} */
  const store = { ...initial };
  return {
    unlock: async () => {},
    getSecret: async (key) => store[key] ?? "",
    setSecret: async (key, value) => {
      store[key] = value;
    },
    _store: store,
  };
}

const paperclipCfg = {};

describe("resolvePaperclipSecretsForMaintain", () => {
  it("adopts guest secrets when vault is empty", async () => {
    const vault = mockVault();
    const result = await resolvePaperclipSecretsForMaintain(vault, paperclipCfg, {
      dbPassword: "guest-db-pass",
      betterAuthSecret: "guest-auth-secret",
    });
    expect(result.dbPassword).toBe("guest-db-pass");
    expect(result.betterAuthSecret).toBe("guest-auth-secret");
    expect(vault._store.HDC_PAPERCLIP_DB_PASSWORD).toBe("guest-db-pass");
    expect(vault._store.HDC_PAPERCLIP_BETTER_AUTH_SECRET).toBe("guest-auth-secret");
  });

  it("adopts guest secrets when vault differs", async () => {
    const vault = mockVault({
      HDC_PAPERCLIP_DB_PASSWORD: "vault-db-pass",
      HDC_PAPERCLIP_BETTER_AUTH_SECRET: "vault-auth-secret",
    });
    const result = await resolvePaperclipSecretsForMaintain(vault, paperclipCfg, {
      dbPassword: "guest-db-pass",
      betterAuthSecret: "guest-auth-secret",
    });
    expect(result.dbPassword).toBe("guest-db-pass");
    expect(result.betterAuthSecret).toBe("guest-auth-secret");
    expect(vault._store.HDC_PAPERCLIP_DB_PASSWORD).toBe("guest-db-pass");
    expect(vault._store.HDC_PAPERCLIP_BETTER_AUTH_SECRET).toBe("guest-auth-secret");
  });

  it("uses vault secrets when guest .env has no values", async () => {
    const vault = mockVault({
      HDC_PAPERCLIP_DB_PASSWORD: "vault-db-pass",
      HDC_PAPERCLIP_BETTER_AUTH_SECRET: "vault-auth-secret",
    });
    const result = await resolvePaperclipSecretsForMaintain(vault, paperclipCfg, {
      dbPassword: "",
      betterAuthSecret: "",
    });
    expect(result.dbPassword).toBe("vault-db-pass");
    expect(result.betterAuthSecret).toBe("vault-auth-secret");
  });

  it("fails when both guest and vault lack required secrets", async () => {
    const vault = mockVault();
    await expect(resolvePaperclipSecretsForMaintain(vault, paperclipCfg, {})).rejects.toThrow(
      /BETTER_AUTH_SECRET and DB password required/,
    );
  });
});
