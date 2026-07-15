import { describe, expect, it } from "vitest";

import { planDomainSync } from "./smtp2go-sync.mjs";

describe("smtp2go-sync", () => {
  const defaults = {
    tracking_subdomain: "link",
    returnpath_subdomain: null,
    auto_verify: false,
  };

  const managedEntry = {
    id: "hdc-example-invalid",
    domain: "hdc.example.invalid",
    managed: true,
    tracking_subdomain: "link",
    returnpath_subdomain: null,
    notes: null,
    dmarc: null,
    spf: null,
    spf_variant: null,
  };

  it("planDomainSync skips unmanaged entries", () => {
    const plan = planDomainSync({
      entry: { ...managedEntry, managed: false },
      live: null,
      defaults,
    });
    expect(plan.action).toBe("skip");
  });

  it("planDomainSync plans add when domain missing in live", () => {
    const plan = planDomainSync({
      entry: managedEntry,
      live: null,
      defaults,
    });
    expect(plan.action).toBe("add");
    expect(plan.addOpts?.trackingSubdomain).toBe("link");
  });

  it("planDomainSync plans verify when not fully verified", () => {
    const plan = planDomainSync({
      entry: managedEntry,
      live: {
        domain: {
          fulldomain: "hdc.example.invalid",
          dkim_verified: false,
          rpath_verified: true,
        },
        trackers: [],
      },
      defaults,
    });
    expect(plan.action).toBe("verify");
  });
});
