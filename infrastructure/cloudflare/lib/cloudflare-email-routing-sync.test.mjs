import { describe, expect, it } from "vitest";

import {
  configEntryToCatchAll,
  configEntryToEmailRoutingRule,
  emailRoutingRuleMatchKey,
} from "./cloudflare-email-routing-config.mjs";
import {
  planCatchAllSync,
  planEmailRoutingRuleSync,
} from "./cloudflare-email-routing-sync.mjs";

describe("cloudflare-email-routing-config", () => {
  it("builds email routing match keys for literal to matchers", () => {
    const rule = configEntryToEmailRoutingRule({
      id: "info",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "info@example.com" }],
      actions: [{ type: "forward", value: ["user@gmail.com"] }],
    });
    expect(rule).not.toBeNull();
    expect(
      emailRoutingRuleMatchKey(/** @type {import('./cloudflare-email-routing-config.mjs').NormalizedEmailRoutingRule} */ ({
        id: "info",
        enabled: true,
        matchers: rule.matchers,
        actions: rule.actions,
      }))
    ).toBe("literal|to|info@example.com");
  });

  it("parses catch-all config", () => {
    const catchAll = configEntryToCatchAll({
      enabled: false,
      actions: [{ type: "drop" }],
    });
    expect(catchAll).toEqual({ enabled: false, actions: [{ type: "drop" }] });
  });
});

describe("planEmailRoutingRuleSync", () => {
  const desiredRule = {
    id: "info-forward",
    cf_id: "er-1",
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: "info@example.com" }],
    actions: [{ type: "forward", value: ["user@gmail.com"] }],
  };

  it("plans create when missing live", () => {
    const plan = planEmailRoutingRuleSync([desiredRule], [], false);
    expect(plan.summary.create).toBe(1);
  });

  it("plans update when enabled differs", () => {
    const plan = planEmailRoutingRuleSync(
      [{ ...desiredRule, enabled: false }],
      [
        {
          id: "er-1",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "info@example.com" }],
          actions: [{ type: "forward", value: ["user@gmail.com"] }],
        },
      ],
      false
    );
    expect(plan.summary.update).toBe(1);
  });

  it("plans delete with prune", () => {
    const plan = planEmailRoutingRuleSync([], [
      {
        id: "er-orphan",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "orphan@example.com" }],
        actions: [{ type: "drop" }],
      },
    ], true);
    expect(plan.summary.delete).toBe(1);
  });
});

describe("planCatchAllSync", () => {
  it("plans update when catch-all differs", () => {
    const plan = planCatchAllSync(
      { enabled: true, actions: [{ type: "drop" }] },
      { enabled: false, actions: [{ type: "drop" }] }
    );
    expect(plan.update).toBe(true);
    expect(plan.summary.update).toBe(1);
  });

  it("returns unchanged when desired is missing", () => {
    const plan = planCatchAllSync(undefined, { enabled: true, actions: [{ type: "drop" }] });
    expect(plan.update).toBe(false);
    expect(plan.summary.unchanged).toBe(1);
  });
});
