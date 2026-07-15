import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyAllowedSendersSync,
  applyIpAllowListSync,
  planAllowedSendersSync,
  planIpAllowListSync,
} from "./smtp2go-restrictions-sync.mjs";

describe("smtp2go-restrictions-sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("planIpAllowListSync skips when not managed", () => {
    const plan = planIpAllowListSync({
      config: { managed: false, enabled: false, entries: [] },
      live: { enabled: false, ip_addresses: [] },
    });
    expect(plan.action).toBe("skip");
  });

  it("planIpAllowListSync plans add and enable steps", () => {
    const plan = planIpAllowListSync({
      config: {
        managed: true,
        enabled: true,
        entries: [{ ip_address: "203.0.113.10", description: "relay" }],
      },
      live: { enabled: false, ip_addresses: [] },
    });
    expect(plan.action).toBe("sync");
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        { type: "set_enabled", enabled: true },
        { type: "add", ip_address: "203.0.113.10", description: "relay" },
      ])
    );
  });

  it("planIpAllowListSync plans prune remove", () => {
    const plan = planIpAllowListSync({
      config: { managed: true, enabled: true, entries: [] },
      live: {
        enabled: true,
        ip_addresses: [{ ip_address: "198.51.100.1/32", description: "extra" }],
      },
      prune: true,
    });
    expect(plan.steps).toEqual([{ type: "remove", ip_address: "198.51.100.1" }]);
  });

  it("planAllowedSendersSync plans update when mode differs", () => {
    const plan = planAllowedSendersSync({
      config: { managed: true, mode: "disabled", senders: ["noreply@example.com"] },
      live: { mode: "whitelist", allowed_senders: ["noreply@example.com"] },
    });
    expect(plan.action).toBe("update");
    expect(plan.mode).toBe("disabled");
  });

  it("applyIpAllowListSync dry-run does not call fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = {
      setIpAllowListEnabled: vi.fn(),
      addIpAllowListEntry: vi.fn(),
      editIpAllowListEntry: vi.fn(),
      removeIpAllowListEntry: vi.fn(),
    };
    const plan = planIpAllowListSync({
      config: {
        managed: true,
        enabled: true,
        entries: [{ ip_address: "203.0.113.10", description: null }],
      },
      live: { enabled: false, ip_addresses: [] },
    });
    const result = await applyIpAllowListSync(api, plan, { dryRun: true, log: () => {} });
    expect(result.ok).toBe(true);
    expect(api.setIpAllowListEnabled).not.toHaveBeenCalled();
    expect(api.addIpAllowListEntry).not.toHaveBeenCalled();
  });
});
