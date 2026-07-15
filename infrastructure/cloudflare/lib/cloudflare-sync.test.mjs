import { describe, expect, it } from "vitest";

import {
  normalizeRecordData,
  normalizeRecordName,
  recordMatchKey,
  recordsNeedUpdate,
} from "./cloudflare-config.mjs";
import { planZoneSync } from "./cloudflare-sync.mjs";

const ZONE = "example.com";

describe("cloudflare-config normalization", () => {
  it("normalizes apex and FQDN record names", () => {
    expect(normalizeRecordName("@", ZONE)).toBe("@");
    expect(normalizeRecordName("www", ZONE)).toBe("www");
    expect(normalizeRecordName("www.example.com", ZONE)).toBe("www");
    expect(normalizeRecordName("example.com", ZONE)).toBe("@");
  });

  it("normalizes MX data with priority", () => {
    expect(normalizeRecordData("MX", "mail.example.com", 10)).toBe("10 mail.example.com");
  });

  it("builds stable record match keys", () => {
    const a = { type: "A", name: "www", data: "203.0.113.1", ttl: 300, proxied: false };
    const b = { type: "A", name: "www.example.com", data: "203.0.113.1", ttl: 300, proxied: false };
    expect(recordMatchKey(a, ZONE)).toBe(recordMatchKey(b, ZONE));
  });
});

describe("planZoneSync", () => {
  it("plans create when desired record is missing live", () => {
    const plan = planZoneSync({
      desired: [{ type: "A", name: "ha", data: "203.0.113.10", ttl: 300, proxied: true }],
      live: [],
      zoneName: ZONE,
    });
    expect(plan.summary.create).toBe(1);
    expect(plan.summary.update).toBe(0);
    expect(plan.summary.delete).toBe(0);
  });

  it("plans update when proxied differs", () => {
    const plan = planZoneSync({
      desired: [{ type: "A", name: "ha", data: "203.0.113.10", ttl: 300, proxied: true }],
      live: [
        {
          id: "rec1",
          type: "A",
          name: "ha.example.com",
          content: "203.0.113.10",
          ttl: 300,
          proxied: false,
        },
      ],
      zoneName: ZONE,
    });
    expect(plan.summary.create).toBe(0);
    expect(plan.summary.update).toBe(1);
  });

  it("does not plan delete without prune", () => {
    const plan = planZoneSync({
      desired: [],
      live: [
        {
          id: "rec1",
          type: "TXT",
          name: "_acme-challenge.example.com",
          content: "token",
          ttl: 120,
        },
      ],
      zoneName: ZONE,
      prune: false,
    });
    expect(plan.summary.delete).toBe(0);
  });

  it("plans delete with prune", () => {
    const plan = planZoneSync({
      desired: [],
      live: [
        {
          id: "rec1",
          type: "TXT",
          name: "_acme-challenge.example.com",
          content: "token",
          ttl: 120,
        },
      ],
      zoneName: ZONE,
      prune: true,
    });
    expect(plan.summary.delete).toBe(1);
  });

  it("detects unchanged records", () => {
    const desired = [{ type: "CNAME", name: "www", data: "example.com", ttl: 300, proxied: false }];
    const plan = planZoneSync({
      desired,
      live: [
        {
          id: "rec1",
          type: "CNAME",
          name: "www.example.com",
          content: "example.com",
          ttl: 300,
          proxied: false,
        },
      ],
      zoneName: ZONE,
    });
    expect(plan.summary.unchanged).toBe(1);
    expect(recordsNeedUpdate(desired[0], { ...desired[0], name: "www" })).toBe(false);
  });
});
