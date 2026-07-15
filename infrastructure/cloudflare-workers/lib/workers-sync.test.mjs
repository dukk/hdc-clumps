import { describe, expect, it } from "vitest";

import { planRouteSync, planSecretSync } from "./workers-sync.mjs";

describe("workers-sync", () => {
  it("plans route create for missing live route", () => {
    const plan = planRouteSync(
      [{ pattern: "api.example.com/*", zone_name: "example.com" }],
      [],
      "my-worker",
      false
    );
    expect(plan.summary.create).toBe(1);
    expect(plan.items[0].action).toBe("create");
  });

  it("plans route delete on prune", () => {
    const plan = planRouteSync(
      [],
      [{ id: "r1", pattern: "old.example.com/*", script: "my-worker" }],
      "my-worker",
      true
    );
    expect(plan.summary.delete).toBe(1);
    expect(plan.items[0].action).toBe("delete");
  });

  it("plans secret put for all configured secrets", () => {
    const plan = planSecretSync(
      [{ name: "API_KEY", vault_key: "HDC_KEY" }],
      [{ name: "API_KEY" }]
    );
    expect(plan.summary.put).toBe(1);
    expect(plan.items[0].action).toBe("put");
  });
});
