import { describe, expect, it } from "vitest";

import {
  mergePlayersByUuid,
  parseLiveOps,
  parseLiveWhitelistPlayers,
} from "./minecraft-lists-import.mjs";

describe("minecraft-lists-import", () => {
  it("parses live Paper whitelist and strips Floodgate prefix", () => {
    expect(
      parseLiveWhitelistPlayers([
        { uuid: "8617f7ca-c3b7-4fa3-a964-8235e6e68136", name: "dukk" },
        { uuid: "00000000-0000-0000-0009-01f113738f86", name: ".MJGamer145572" },
      ]),
    ).toEqual([
      { uuid: "8617f7ca-c3b7-4fa3-a964-8235e6e68136", name: "dukk" },
      {
        uuid: "00000000-0000-0000-0009-01f113738f86",
        name: "MJGamer145572",
        edition: "bedrock",
      },
    ]);
  });

  it("parses live ops", () => {
    expect(
      parseLiveOps([
        {
          uuid: "8617f7ca-c3b7-4fa3-a964-8235e6e68136",
          name: "dukk",
          level: 4,
          bypassesPlayerLimit: false,
        },
      ]),
    ).toEqual([
      {
        uuid: "8617f7ca-c3b7-4fa3-a964-8235e6e68136",
        name: "dukk",
        level: 4,
        bypassesPlayerLimit: false,
      },
    ]);
  });

  it("merges by uuid with live winning and config-only kept", () => {
    const live = [
      { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "LiveName", level: 4, bypassesPlayerLimit: false },
    ];
    const config = [
      { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "ConfigName", level: 3, bypassesPlayerLimit: true },
      {
        uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        name: "ConfigOnly",
        level: 4,
        bypassesPlayerLimit: false,
      },
    ];
    expect(mergePlayersByUuid(live, config)).toEqual([
      {
        uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        name: "ConfigOnly",
        level: 4,
        bypassesPlayerLimit: false,
      },
      { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "LiveName", level: 4, bypassesPlayerLimit: false },
    ]);
  });
});
