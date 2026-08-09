import { describe, expect, it } from "vitest";

import {
  applyFloodgatePrefix,
  isFloodgateUuid,
  parseGeyserXuidJson,
  parsePlayerDbXuidJson,
  parseXboxReplayXuid,
  toPaperWhitelistPlayers,
  xuidToFloodgateUuid,
} from "./floodgate-uuid.mjs";

describe("floodgate-uuid", () => {
  it("maps Xbox XUID to Floodgate UUID(0, xuid)", () => {
    expect(xuidToFloodgateUuid("2535409715482502")).toBe("00000000-0000-0000-0009-01f113738f86");
    expect(xuidToFloodgateUuid(2535409715482502n)).toBe("00000000-0000-0000-0009-01f113738f86");
    expect(isFloodgateUuid("00000000-0000-0000-0009-01f113738f86")).toBe(true);
    expect(isFloodgateUuid("8617f7ca-c3b7-4fa3-a964-8235e6e68136")).toBe(false);
  });

  it("applies Floodgate username prefix once", () => {
    expect(applyFloodgatePrefix("MJGamer145572")).toBe(".MJGamer145572");
    expect(applyFloodgatePrefix(".MJGamer145572")).toBe(".MJGamer145572");
    expect(applyFloodgatePrefix("Steve", "")).toBe("Steve");
  });

  it("parses XUID from Geyser, PlayerDB, and XboxReplay bodies", () => {
    expect(parseGeyserXuidJson({ xuid: "2535409715482502" })).toBe("2535409715482502");
    expect(parseGeyserXuidJson({ message: "Unable to find user in our cache" })).toBeNull();
    expect(parsePlayerDbXuidJson({ success: true, data: { player: { id: "2535409715482502" } } })).toBe(
      "2535409715482502",
    );
    expect(
      parseXboxReplayXuid(
        'href="https://gameclipscontent-t3016.media.xboxlive.com/xuid-2535409715482502-public/thumb.png"',
      ),
    ).toBe("2535409715482502");
  });

  it("renders Paper whitelist names with Floodgate prefix for Bedrock", () => {
    expect(
      toPaperWhitelistPlayers([
        { uuid: "8617f7ca-c3b7-4fa3-a964-8235e6e68136", name: "dukk", edition: "java" },
        {
          uuid: "00000000-0000-0000-0009-01f113738f86",
          name: "MJGamer145572",
          edition: "bedrock",
        },
      ]),
    ).toEqual([
      { uuid: "8617f7ca-c3b7-4fa3-a964-8235e6e68136", name: "dukk" },
      { uuid: "00000000-0000-0000-0009-01f113738f86", name: ".MJGamer145572" },
    ]);
  });
});
