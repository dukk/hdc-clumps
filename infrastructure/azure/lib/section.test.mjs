import { describe, expect, it } from "vitest";

import { resolveAzureSection } from "./section.mjs";

describe("resolveAzureSection", () => {
  it("defaults to entra", () => {
    expect(resolveAzureSection({})).toBe("entra");
  });

  it("accepts compute aliases", () => {
    expect(resolveAzureSection({ section: "compute" })).toBe("compute");
    expect(resolveAzureSection({ section: "arm" })).toBe("compute");
  });

  it("accepts all when allowed", () => {
    expect(resolveAzureSection({ section: "all" }, { allowAll: true })).toBe("all");
  });

  it("rejects all when not allowed", () => {
    expect(() => resolveAzureSection({ section: "all" }, { allowAll: false })).toThrow(
      /not valid/
    );
  });
});
