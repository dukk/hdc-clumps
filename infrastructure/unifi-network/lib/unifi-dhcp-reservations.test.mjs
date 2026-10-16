import { describe, expect, it } from "vitest";
import { networkIdForIp, normalizeDhcpReservationsConfig, planDhcpReservation } from "./unifi-dhcp-reservations.mjs";

describe("dhcp reservations", () => {
  it("normalizes MAC and rejects duplicates", () => {
    expect(normalizeDhcpReservationsConfig([{ mac: "BC:24:11:21:7F:E7", ip: "10.0.0.180" }])[0].mac).toBe("bc:24:11:21:7f:e7");
    expect(() => normalizeDhcpReservationsConfig([{ mac: "bc2411217fe7", ip: "10.0.0.1" }, { mac: "bc:24:11:21:7f:e7", ip: "10.0.0.2" }])).toThrow(/duplicate mac/);
    expect(() => normalizeDhcpReservationsConfig([{ mac: "x", ip: "10.0.0.1" }])).toThrow(/mac/);
  });
  it("finds the network by subnet", () => {
    const nets = [{ _id: "iot", ip_subnet: "10.1.0.1/24" }, { _id: "lan", ip_subnet: "10.0.0.1/24" }];
    expect(networkIdForIp(nets, "10.0.0.180")).toBe("lan");
    expect(networkIdForIp(nets, "10.9.0.1")).toBe("");
  });
  it("plans create/update/unchanged", () => {
    const want = { mac: "bc:24:11:21:7f:e7", ip: "10.0.0.180", name: "", networkId: "" };
    expect(planDhcpReservation(want, null, "lan").action).toBe("create");
    expect(planDhcpReservation(want, { _id: "u", use_fixedip: false }, "lan").action).toBe("update");
    expect(planDhcpReservation(want, { _id: "u", use_fixedip: true, fixed_ip: "10.0.0.180", network_id: "lan", name: "vm-win11-a" }, "lan").action).toBe("unchanged");
  });
});