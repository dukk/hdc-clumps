import { describe, expect, it } from "vitest";

import {
  apiKeyIdFromName,
  findLiveKeyForEntry,
  keyMetadataDrift,
  liveKeyToConfig,
  normalizeOpenrouterConfig,
  resolveKeyLimit,
} from "./openrouter-config.mjs";
import { collectOpenrouterState } from "./openrouter-collect.mjs";
import { liveStateToApiKeys } from "./openrouter-import.mjs";
import { planKeySync } from "./openrouter-sync.mjs";

describe("openrouter-config", () => {
  it("apiKeyIdFromName slugifies label", () => {
    expect(apiKeyIdFromName("Hermes Agent")).toBe("hermes-agent");
  });

  it("normalizeOpenrouterConfig reads api_keys and defaults", () => {
    const cfg = normalizeOpenrouterConfig({
      schema_version: 1,
      openrouter: {},
      defaults: { limit_usd: 25, include_byok_in_limit: true },
      credits: { low_balance_usd: 10 },
      api_keys: [
        {
          id: "hermes",
          name: "Hermes Agent",
          managed: true,
          inference_api_key_vault_key: "HDC_HERMES_OPENROUTER_API_KEY",
          limit_usd: 50,
        },
      ],
    });
    expect(cfg.apiKeys).toHaveLength(1);
    expect(cfg.apiKeys[0].managed).toBe(true);
    expect(cfg.defaults.limit_usd).toBe(25);
    expect(cfg.credits.low_balance_usd).toBe(10);
    expect(resolveKeyLimit(cfg.apiKeys[0], cfg.defaults)).toBe(50);
  });

  it("liveKeyToConfig preserves managed and consumer from existing entry", () => {
    const row = {
      hash: "abc123",
      name: "Hermes Agent",
      limit: 50,
      limit_remaining: 40,
      limit_reset: null,
      include_byok_in_limit: false,
      disabled: false,
      usage: 10,
      usage_daily: 1,
      usage_weekly: 5,
      usage_monthly: 10,
    };
    const existing = {
      id: "hermes",
      name: "Hermes Agent",
      managed: true,
      inference_api_key_vault_key: "HDC_HERMES_OPENROUTER_API_KEY",
      openrouter_hash: "abc123",
      limit_usd: 50,
      limit_reset: null,
      include_byok_in_limit: false,
      disabled: false,
      consumer: "hermes-a",
      notes: "primary",
    };
    const next = liveKeyToConfig(row, existing);
    expect(next.managed).toBe(true);
    expect(next.consumer).toBe("hermes-a");
    expect(next.notes).toBe("primary");
    expect(next.openrouter_hash).toBe("abc123");
  });

  it("findLiveKeyForEntry prefers hash then name", () => {
    const entry = {
      id: "hermes",
      name: "Hermes Agent",
      managed: true,
      inference_api_key_vault_key: null,
      openrouter_hash: "hash-a",
      limit_usd: null,
      limit_reset: null,
      include_byok_in_limit: false,
      disabled: false,
      consumer: null,
      notes: null,
    };
    const live = [
      {
        hash: "hash-a",
        name: "Other",
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        include_byok_in_limit: false,
        usage: 0,
        usage_daily: 0,
        usage_weekly: 0,
        usage_monthly: 0,
      },
    ];
    expect(findLiveKeyForEntry(entry, live)?.hash).toBe("hash-a");
  });

  it("keyMetadataDrift detects limit mismatch", () => {
    const entry = {
      id: "hermes",
      name: "Hermes Agent",
      managed: true,
      inference_api_key_vault_key: null,
      openrouter_hash: "hash-a",
      limit_usd: 50,
      limit_reset: null,
      include_byok_in_limit: false,
      disabled: false,
      consumer: null,
      notes: null,
    };
    const live = {
      hash: "hash-a",
      name: "Hermes Agent",
      limit: 25,
      limit_remaining: 20,
      limit_reset: null,
      include_byok_in_limit: false,
      disabled: false,
      usage: 0,
      usage_daily: 0,
      usage_weekly: 0,
      usage_monthly: 0,
    };
    const drift = keyMetadataDrift(entry, live);
    expect(drift.has_drift).toBe(true);
    expect(drift.fields).toContain("limit_usd");
  });
});

describe("openrouter-collect", () => {
  it("collectOpenrouterState flags missing managed key and low credits", () => {
    const config = normalizeOpenrouterConfig({
      schema_version: 1,
      openrouter: {},
      credits: { low_balance_usd: 5 },
      api_keys: [
        {
          id: "hermes",
          name: "Hermes Agent",
          managed: true,
          openrouter_hash: "missing-hash",
        },
      ],
    });
    const state = collectOpenrouterState({
      config,
      live: {
        credits: { total_credits: 10, total_usage: 9 },
        keys: [],
      },
    });
    expect(state.has_drift).toBe(true);
    expect(state.credits.low_balance).toBe(true);
    expect(state.api_keys[0].missing_in_live).toBe(true);
  });
});

describe("openrouter-sync", () => {
  it("planKeySync plans create when managed key missing", () => {
    const config = normalizeOpenrouterConfig({
      schema_version: 1,
      openrouter: {},
      defaults: { limit_usd: 100 },
      api_keys: [{ id: "hermes", name: "Hermes Agent", managed: true }],
    });
    const plan = planKeySync({
      entry: config.apiKeys[0],
      live: null,
      defaults: config.defaults,
    });
    expect(plan.action).toBe("create");
    expect(plan.payload.limit).toBe(100);
  });

  it("planKeySync skips unmanaged keys", () => {
    const config = normalizeOpenrouterConfig({
      schema_version: 1,
      openrouter: {},
      api_keys: [{ id: "hermes", name: "Hermes Agent", managed: false }],
    });
    const plan = planKeySync({
      entry: config.apiKeys[0],
      live: null,
      defaults: config.defaults,
    });
    expect(plan.action).toBe("skip");
  });
});

describe("openrouter-import", () => {
  it("liveStateToApiKeys preserves hdc-local fields on re-import", () => {
    const existingByHash = new Map([
      [
        "hash-a",
        {
          id: "hermes",
          name: "Hermes Agent",
          managed: true,
          inference_api_key_vault_key: "HDC_HERMES_OPENROUTER_API_KEY",
          openrouter_hash: "hash-a",
          limit_usd: 50,
          limit_reset: null,
          include_byok_in_limit: false,
          disabled: false,
          consumer: "hermes-a",
          notes: "keep",
        },
      ],
    ]);
    const keys = liveStateToApiKeys(
      {
        keys: [
          {
            hash: "hash-a",
            name: "Hermes Agent",
            limit: 50,
            limit_remaining: 40,
            limit_reset: null,
            include_byok_in_limit: false,
            disabled: false,
            usage: 0,
            usage_daily: 0,
            usage_weekly: 0,
            usage_monthly: 0,
          },
        ],
      },
      existingByHash,
      new Map()
    );
    expect(keys[0].consumer).toBe("hermes-a");
    expect(keys[0].notes).toBe("keep");
  });
});
