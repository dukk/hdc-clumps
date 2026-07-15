import { describe, expect, it } from "vitest";

import {
  normalizeTwilioConfig,
  phoneNumberHasDrift,
  slugifyId,
  trunkHasDrift,
  trunkIdFromLive,
} from "./twilio-config.mjs";

describe("twilio-config", () => {
  it("slugifyId normalizes friendly names", () => {
    expect(slugifyId("My Trunk!")).toBe("my-trunk");
  });

  it("trunkIdFromLive prefers domain prefix", () => {
    expect(
      trunkIdFromLive({
        sid: "TK123",
        friendly_name: "Office",
        domain_name: "mytrunk.pstn.twilio.com",
      })
    ).toBe("mytrunk");
  });

  it("normalizeTwilioConfig parses sip trunks and phone numbers", () => {
    const config = normalizeTwilioConfig({
      schema_version: 1,
      twilio: { auth: {} },
      sip_trunks: [
        {
          id: "main",
          sid: "TKabc",
          termination_domain: "main.pstn.twilio.com",
          origination_urls: [{ sid: "OU1", sip_url: "sip:192.0.2.1" }],
        },
      ],
      phone_numbers: [{ sid: "PN1", phone_number: "+15551234567" }],
    });
    expect(config.sipTrunks).toHaveLength(1);
    expect(config.sipTrunks[0].id).toBe("main");
    expect(config.phoneNumbers).toHaveLength(1);
    expect(config.trunksById.get("main")?.sid).toBe("TKabc");
  });

  it("trunkHasDrift detects termination domain changes", () => {
    const base = {
      id: "main",
      sid: "TKabc",
      friendly_name: null,
      termination_domain: "main.pstn.twilio.com",
      origination_urls: [],
      trunk_phone_numbers: [],
      credential_lists: [],
    };
    const changed = { ...base, termination_domain: "other.pstn.twilio.com" };
    expect(trunkHasDrift(base, changed)).toBe(true);
    expect(trunkHasDrift(base, { ...base })).toBe(false);
  });

  it("phoneNumberHasDrift detects voice_url changes", () => {
    const base = {
      sid: "PN1",
      phone_number: "+15551234567",
      friendly_name: null,
      voice_url: null,
      sms_url: null,
      trunk_sid: null,
      capabilities: null,
    };
    const changed = { ...base, voice_url: "https://example.invalid/voice" };
    expect(phoneNumberHasDrift(base, changed)).toBe(true);
  });
});
