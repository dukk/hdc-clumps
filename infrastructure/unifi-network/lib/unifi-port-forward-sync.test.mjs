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

  it("plans update when non-key fields drift", () => {
    const plan = planPortForwardSync([desired({ enabled: false })], [live()]);
    expect(plan.summary.update).toBe(1);
    expect(plan.update[0].unifiId).toBe("abc123");
  });

  it("matches by unifi_id when configured", () => {
    const plan = planPortForwardSync(
      [desired({ unifi_id: "abc123", name: "Renamed in config", dst_port: "8443" })],
      [live({ name: "Old name on controller", dst_port: "8443" })],
    );
    expect(plan.summary.update).toBe(1);
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
