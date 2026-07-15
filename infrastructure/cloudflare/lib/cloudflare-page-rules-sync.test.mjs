import { describe, expect, it } from "vitest";

import {
  configEntryToPageRule,
  pageRuleMatchKey,
  pageRulesNeedUpdate,
  slugFromPageRuleTarget,
} from "./cloudflare-page-rules-config.mjs";
import { planPageRuleSync } from "./cloudflare-page-rules-sync.mjs";

describe("cloudflare-page-rules-config", () => {
  it("builds stable page rule match keys", () => {
    const rule = configEntryToPageRule({
      id: "force-https",
      priority: 1,
      status: "active",
      target: { operator: "matches", value: "*example.com/*" },
      actions: [{ id: "always_use_https", value: "on" }],
    });
    expect(rule).not.toBeNull();
    expect(pageRuleMatchKey(/** @type {import('./cloudflare-page-rules-config.mjs').NormalizedPageRule} */ ({
      ...rule,
      id: rule.id,
    }))).toBe("1|matches|*example.com/*");
  });

  it("slugifies page rule targets for import ids", () => {
    expect(slugFromPageRuleTarget({ operator: "matches", value: "*example.invalid/*" })).toBe(
      "matches-example-invalid"
    );
  });
});

describe("planPageRuleSync", () => {
  const desiredRule = {
    id: "force-https",
    cf_id: "pr-1",
    priority: 1,
    status: "active",
    target: { operator: "matches", value: "*example.com/*" },
    actions: [{ id: "always_use_https", value: "on" }],
  };

  it("plans create when desired rule is missing live", () => {
    const plan = planPageRuleSync([desiredRule], [], false);
    expect(plan.summary.create).toBe(1);
    expect(plan.summary.update).toBe(0);
  });

  it("plans update when status differs", () => {
    const plan = planPageRuleSync(
      [{ ...desiredRule, status: "disabled" }],
      [
        {
          id: "pr-1",
          priority: 1,
          status: "active",
          targets: [
            { target: "url", constraint: { operator: "matches", value: "*example.com/*" } },
          ],
          actions: [{ id: "always_use_https", value: "on" }],
        },
      ],
      false
    );
    expect(plan.summary.update).toBe(1);
  });

  it("matches by cf_id when semantic key differs", () => {
    const plan = planPageRuleSync(
      [desiredRule],
      [
        {
          id: "pr-1",
          priority: 2,
          status: "active",
          targets: [
            { target: "url", constraint: { operator: "matches", value: "*example.com/*" } },
          ],
          actions: [{ id: "always_use_https", value: "on" }],
        },
      ],
      false
    );
    expect(plan.summary.update).toBe(1);
  });

  it("does not plan delete without prune", () => {
    const plan = planPageRuleSync([], [
      {
        id: "pr-orphan",
        priority: 1,
        status: "active",
        targets: [{ target: "url", constraint: { operator: "matches", value: "*x/*" } }],
        actions: [{ id: "browser_check", value: "on" }],
      },
    ]);
    expect(plan.summary.delete).toBe(0);
  });

  it("plans delete with prune", () => {
    const plan = planPageRuleSync([], [
      {
        id: "pr-orphan",
        priority: 1,
        status: "active",
        targets: [{ target: "url", constraint: { operator: "matches", value: "*x/*" } }],
        actions: [{ id: "browser_check", value: "on" }],
      },
    ], true);
    expect(plan.summary.delete).toBe(1);
  });

  it("detects action changes", () => {
    const a = {
      id: "r",
      priority: 1,
      status: "active",
      target: { operator: "matches", value: "*a/*" },
      actions: [{ id: "always_use_https", value: "on" }],
    };
    const b = {
      id: "r",
      priority: 1,
      status: "active",
      target: { operator: "matches", value: "*a/*" },
      actions: [{ id: "always_use_https", value: "off" }],
    };
    expect(pageRulesNeedUpdate(a, b)).toBe(true);
  });
});
