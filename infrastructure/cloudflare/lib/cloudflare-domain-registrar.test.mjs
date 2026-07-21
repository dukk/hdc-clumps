import { describe, expect, it } from "vitest";

import { pickRdapExpiry, pickRdapRegistrarName } from "./cloudflare-domain-registrar.mjs";

describe("pickRdapExpiry", () => {
  it("reads expiration eventDate", () => {
    expect(
      pickRdapExpiry({
        events: [
          { eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" },
          { eventAction: "expiration", eventDate: "2027-05-10T12:00:00Z" },
        ],
      }),
    ).toBe("2027-05-10T12:00:00Z");
  });

  it("falls back to expiry-like actions", () => {
    expect(
      pickRdapExpiry({
        events: [{ eventAction: "expiration date", eventDate: "2028-01-01T00:00:00Z" }],
      }),
    ).toBe("2028-01-01T00:00:00Z");
  });

  it("returns null when missing", () => {
    expect(pickRdapExpiry(null)).toBeNull();
    expect(pickRdapExpiry({})).toBeNull();
    expect(pickRdapExpiry({ events: [] })).toBeNull();
  });
});

describe("pickRdapRegistrarName", () => {
  it("reads fn from registrar entity vcard", () => {
    expect(
      pickRdapRegistrarName({
        entities: [
          {
            roles: ["registrar"],
            vcardArray: ["vcard", [["fn", {}, "text", "Cloudflare, Inc."]]],
          },
        ],
      }),
    ).toBe("Cloudflare, Inc.");
  });

  it("returns null without registrar entity", () => {
    expect(pickRdapRegistrarName({ entities: [{ roles: ["registrant"] }] })).toBeNull();
  });
});
