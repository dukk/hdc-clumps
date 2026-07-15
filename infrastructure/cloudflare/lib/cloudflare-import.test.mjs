import { describe, expect, it } from "vitest";

import {
  importEmailRoutingRulesFromLive,
  importPageRulesFromLive,
  importZonesFromLive,
  normalizedRecordToConfigEntry,
} from "./cloudflare-import.mjs";

describe("cloudflare-import", () => {
  it("normalizedRecordToConfigEntry maps A, CNAME, MX, NS", () => {
    expect(
      normalizedRecordToConfigEntry({
        type: "A",
        name: "@",
        data: "203.0.113.1",
        ttl: 300,
        proxied: false,
      })
    ).toEqual({
      type: "A",
      name: "@",
      data: "203.0.113.1",
      ttl: 300,
      proxied: false,
    });

    expect(
      normalizedRecordToConfigEntry({
        type: "CNAME",
        name: "www",
        data: "example.com",
        ttl: 1,
        proxied: true,
      })
    ).toEqual({
      type: "CNAME",
      name: "www",
      data: "example.com",
      ttl: 1,
      proxied: true,
    });

    expect(
      normalizedRecordToConfigEntry({
        type: "MX",
        name: "@",
        data: "10 mail.example.com",
        ttl: 3600,
        proxied: false,
        priority: 10,
      })
    ).toEqual({
      type: "MX",
      name: "@",
      data: "10 mail.example.com",
      ttl: 3600,
      priority: 10,
    });

    expect(
      normalizedRecordToConfigEntry({
        type: "NS",
        name: "@",
        data: "ns1.cloudflare.com",
        ttl: 86400,
        proxied: false,
      })
    ).toEqual({
      type: "NS",
      name: "@",
      data: "ns1.cloudflare.com",
      ttl: 86400,
    });
  });

  it("importZonesFromLive sorts zones and records stably", () => {
    const zones = importZonesFromLive([
      {
        name: "b.example",
        records: [
          { type: "TXT", name: "z", data: "v", ttl: 300, proxied: false },
          { type: "A", name: "www", data: "1.2.3.4", ttl: 300, proxied: false },
        ],
      },
      {
        name: "a.example",
        records: [{ type: "A", name: "@", data: "1.2.3.5", ttl: 300, proxied: false }],
      },
    ]);

    expect(zones.map((z) => z.name)).toEqual(["a.example", "b.example"]);
    expect(zones[1].records.map((r) => `${r.type}/${r.name}`)).toEqual(["A/www", "TXT/z"]);
  });

  it("importZonesFromLive produces config-shaped zones[]", () => {
    const zones = importZonesFromLive([
      {
        name: "example.invalid",
        records: [
          { type: "A", name: "@", data: "203.0.113.10", ttl: 300, proxied: false },
          { type: "CNAME", name: "www", data: "example.invalid", ttl: 300, proxied: false },
        ],
      },
    ]);

    expect(zones).toHaveLength(1);
    expect(zones[0].name).toBe("example.invalid");
    expect(zones[0].records).toHaveLength(2);
    expect(zones[0].records[0].type).toBe("A");
    expect(zones[0].records[1].type).toBe("CNAME");
  });

  it("importPageRulesFromLive generates stable ids and preserves cf_id mapping", () => {
    const rules = importPageRulesFromLive([
      {
        id: "cf-pr-1",
        priority: 1,
        status: "active",
        targets: [{ target: "url", constraint: { operator: "matches", value: "*example.invalid/*" } }],
        actions: [{ id: "always_use_https", value: "on" }],
      },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("matches-example-invalid");
    expect(rules[0].cf_id).toBe("cf-pr-1");
  });

  it("importEmailRoutingRulesFromLive generates ids from matcher", () => {
    const rules = importEmailRoutingRulesFromLive([
      {
        id: "cf-er-1",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "info@example.invalid" }],
        actions: [{ type: "forward", value: ["user@gmail.com"] }],
      },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("to-info-example-invalid");
    expect(rules[0].cf_id).toBe("cf-er-1");
  });
});
