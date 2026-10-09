import { describe, expect, it } from "vitest";

import {
  backupOrphanExcludesFromConfig,
  collectClusterOrphanBackupTargets,
  isOrphanBackupExcluded,
} from "./proxmox-backup-maintain.mjs";

const resources = [
  { vmid: 120, name: "ha-legacy", node: "pve-h", type: "qemu", template: 0 },
  { vmid: 121, name: "Other-Guest", node: "pve-h", type: "lxc", template: 0 },
  { vmid: 122, name: "kept", node: "pve-h", type: "qemu", template: 0 },
];

describe("backupOrphanExcludesFromConfig", () => {
  it("defaults to empty sets", () => {
    const ex = backupOrphanExcludesFromConfig({});
    expect(ex.vmids.size).toBe(0);
    expect(ex.names.size).toBe(0);
  });

  it("parses numeric and string vmids and lowercases names", () => {
    const ex = backupOrphanExcludesFromConfig({
      provision: { backups: { exclude_vmids: [120, "121", "x", -1], exclude_names: [" HA-Legacy ", "", 5] } },
    });
    expect([...ex.vmids]).toEqual([120, 121]);
    expect([...ex.names]).toEqual(["ha-legacy"]);
  });
});

describe("isOrphanBackupExcluded", () => {
  const ex = { vmids: new Set([120]), names: new Set(["other-guest"]) };
  it("matches by vmid or case-insensitive name", () => {
    expect(isOrphanBackupExcluded(resources[0], ex)).toBe(true);
    expect(isOrphanBackupExcluded(resources[1], ex)).toBe(true);
    expect(isOrphanBackupExcluded(resources[2], ex)).toBe(false);
  });
});

describe("collectClusterOrphanBackupTargets excludes", () => {
  it("skips excluded orphans and reports them", () => {
    /** @type {any[]} */
    const excluded = [];
    const orphans = collectClusterOrphanBackupTargets({
      resources,
      coveredVmids: new Set(),
      cfg: { provision: { backups: { exclude_vmids: [120], exclude_names: ["other-guest"] } } },
      hostId: "pve-h",
      excluded,
    });
    expect(orphans.map((o) => o.vmid)).toEqual([122]);
    expect(excluded.map((e) => [e.vmid, e.name])).toEqual([
      [120, "ha-legacy"],
      [121, "Other-Guest"],
    ]);
  });

  it("keeps every orphan when no excludes are set", () => {
    const orphans = collectClusterOrphanBackupTargets({
      resources,
      coveredVmids: new Set([122]),
      cfg: {},
      hostId: "pve-h",
    });
    expect(orphans.map((o) => o.vmid)).toEqual([120, 121]);
  });
});