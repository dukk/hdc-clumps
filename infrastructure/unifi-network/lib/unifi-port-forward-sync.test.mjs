import { describe, expect, it } from "vitest";

import { planPortForwardSync } from "./unifi-port-forward-sync.mjs";

/** @type {import('./unifi-config.mjs').ConfigPortForward} */
function desired(overrides = {}) {
  return {
    id: "pf-test",
    managed: true,
    name: "Test rule",
    enabled: true,
    pfwd_interface: "WAN",
    destination_ip: "any",
    proto: "tcp",
    dst_port: "443",
    fwd: "192.168.1.10",
    fwd_port: "443",
    log: false,
    src: "any",
    ...overrides,
  };
}

/** @param {Record<string, unknown>} overrides */
function live(overrides = {}) {
  return {
    _id: "abc123",
    name: "Test rule",
    enabled: true,
    pfwd_interface: "WAN",
    destination_ip: "any",
    proto: "tcp",
    dst_port: "443",
    fwd: "192.168.1.10",
    fwd_port: "443",
    log: false,
    src: "any",
    ...overrides,
  };
}

describe("planPortForwardSync", () => {
  it("reports unchanged when live matches desired", () => {
    const plan = planPortForwardSync([desired()], [live()]);
    expect(plan.summary).toEqual({ create: 0, update: 0, delete: 0, unchanged: 1 });
  });

  it("plans create when live rule is missing", () => {
    const plan = planPortForwardSync([desired()], []);
    expect(plan.summary.create).toBe(1);
    expect(plan.create[0].desired.id).toBe("pf-test");
  });

  it("plans update when enabled or fwd drifts on a matched rule", () => {
    const plan = planPortForwardSync(
      [desired({ unifi_id: "abc123", enabled: false, fwd: "192.168.1.50" })],
      [live()],
    );
    expect(plan.summary).toEqual({ create: 0, update: 1, delete: 0, unchanged: 0 });
    expect(plan.update[0].desired.fwd).toBe("192.168.1.50");
    expect(plan.update[0].unifiId).toBe("abc123");
  });

  it("treats matched live rules as unchanged when only interface case differs", () => {
    const plan = planPortForwardSync([desired({ pfwd_interface: "wan" })], [live({ pfwd_interface: "WAN" })]);
    expect(plan.summary).toEqual({ create: 0, update: 0, delete: 0, unchanged: 1 });
  });

  it("matches by unifi_id and updates when name or dst_port drifts", () => {
    const plan = planPortForwardSync(
      [desired({ unifi_id: "abc123", name: "Renamed in config", dst_port: "8443" })],
      [live({ name: "Old name on controller", dst_port: "443" })],
    );
    expect(plan.summary).toEqual({ create: 0, update: 1, delete: 0, unchanged: 0 });
  });

  it("does not delete without prune", () => {
    const plan = planPortForwardSync([], [live()]);
    expect(plan.summary.delete).toBe(0);
  });

  it("plans delete with prune for unmatched live rules", () => {
    const plan = planPortForwardSync([], [live()], true);
    expect(plan.summary.delete).toBe(1);
  });

  it("throws on duplicate desired keys", () => {
    expect(() =>
      planPortForwardSync(
        [desired({ name: "Dup" }), desired({ id: "pf-dup-2", name: "Dup" })],
        [],
      ),
    ).toThrow(/Duplicate desired port forward key/);
  });
});
