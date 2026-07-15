import { afterEach, describe, expect, it, vi } from "vitest";

import { createTwilioClient, twilioBasicAuthHeader } from "./twilio-api.mjs";

describe("twilio-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("twilioBasicAuthHeader encodes account sid and token", () => {
    const header = twilioBasicAuthHeader("ACtest", "secret");
    expect(header).toBe(`Basic ${Buffer.from("ACtest:secret", "utf8").toString("base64")}`);
  });

  it("listIncomingPhoneNumbers follows next_page_uri", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            incoming_phone_numbers: [{ sid: "PN1", phone_number: "+15551111111" }],
            next_page_uri:
              "/2010-04-01/Accounts/ACtest/IncomingPhoneNumbers.json?Page=1&PageSize=50",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            incoming_phone_numbers: [{ sid: "PN2", phone_number: "+15552222222" }],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const api = createTwilioClient({ accountSid: "ACtest", authToken: "token" });
    const numbers = await api.listIncomingPhoneNumbers();

    expect(numbers).toHaveLength(2);
    expect(numbers[1].phone_number).toBe("+15552222222");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0][1].headers;
    expect(firstHeaders.Authorization).toBe(twilioBasicAuthHeader("ACtest", "token"));
  });

  it("listCredentials uses Accounts/SIP/CredentialLists path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          credentials: [{ sid: "CR1", username: "sip-user" }],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = createTwilioClient({ accountSid: "ACtest123", authToken: "token" });
    const creds = await api.listCredentials("CLlist123");

    expect(creds).toHaveLength(1);
    expect(creds[0].username).toBe("sip-user");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/Accounts/ACtest123/SIP/CredentialLists/CLlist123/Credentials.json");
  });

  it("listTrunks follows trunking meta.next_page_url", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            trunks: [{ sid: "TK1", domain_name: "a.pstn.twilio.com" }],
            meta: { next_page_url: "https://trunking.twilio.com/v1/Trunks?Page=1" },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            trunks: [{ sid: "TK2", domain_name: "b.pstn.twilio.com" }],
            meta: {},
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const api = createTwilioClient({ accountSid: "ACtest", authToken: "token" });
    const trunks = await api.listTrunks();

    expect(trunks).toHaveLength(2);
    expect(trunks[1].domain_name).toBe("b.pstn.twilio.com");
  });
});
