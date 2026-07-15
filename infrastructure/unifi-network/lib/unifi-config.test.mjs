import { describe, expect, it } from "vitest";

import {
  normalizePortForwardConfigEntry,
  normalizeWanIps,
  portForwardMatchKey,
  resolveDestinationIp,
  wanSuffixFromPortForwardName,
} from "./unifi-config.mjs";

describe("wanSuffixFromPortForwardName", () => {
  it("extracts .234 from rule labels", () => {
    expect(wanSuffixFromPortForwardName("NGINX-WAF-A  HTTP (.234)")).toBe(".234");
    expect(wanSuffixFromPortForwardName("Minecraft (.236-Squeaky)")).toBe(".236");
  });
});

describe("resolveDestinationIp", () => {
  it("prefers explicit destination_ip", () => {
    expect(
      resolveDestinationIp(
        { name: "Test (.234)", destination_ip: "203.0.113.234" },
        { ".235": "203.0.113.235" },
      ),
    ).toBe("203.0.113.234");
  });

  it("resolves from wan_ips using name suffix", () => {
    expect(
      resolveDestinationIp(
        { name: "NGINX-WAF-B HTTP (.235)" },
        { ".234": "203.0.113.234", ".235": "203.0.113.235" },
      ),
    ).toBe("203.0.113.235");
  });

  it("defaults to any when unbound", () => {
    expect(resolveDestinationIp({ name: "Generic rule" })).toBe("any");
  });
});

describe("normalizePortForwardConfigEntry", () => {
  it("stores resolved destination_ip on load", () => {
    const entry = normalizePortForwardConfigEntry(
      {
        id: "pf-test",
        name: "Service (.234)",
        dst_port: "443",
        fwd: "192.0.2.40",
      },
      { ".234": "203.0.113.234" },
    );
    expect(entry.destination_ip).toBe("203.0.113.234");
  });
});

describe("portForwardMatchKey", () => {
  it("includes destination_ip so multi-WAN rules do not collide", () => {
    const a = portForwardMatchKey({
      name: "HTTPS",
      proto: "tcp",
      dst_port: "443",
      destination_ip: "203.0.113.234",
      fwd: "192.0.2.40",
      fwd_port: "443",
    });
    const b = portForwardMatchKey({
      name: "HTTPS",
      proto: "tcp",
      dst_port: "443",
      destination_ip: "203.0.113.235",
      fwd: "192.0.2.41",
      fwd_port: "443",
    });
    expect(a).not.toBe(b);
  });
});

describe("normalizeWanIps", () => {
  it("accepts bare and dotted keys", () => {
    expect(normalizeWanIps({ ".234": "203.0.113.234" })).toEqual({
      ".234": "203.0.113.234",
      "234": "203.0.113.234",
    });
  });
});
