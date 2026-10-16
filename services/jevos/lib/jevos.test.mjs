import { describe, expect, it } from "vitest";

import { guestIpFromLxc, listJevosDeploymentSummaries, resolveJevosDeployments } from "./deployments.mjs";
import { buildJevosInstallScript, buildJevosNftables, buildJevosUnit } from "./jevos-install.mjs";

const cfg = {
  schema_version: 2,
  defaults: {
    mode: "proxmox-lxc",
    proxmox: { lxc: { rootfs_gb: 8, memory_mb: 3072, cores: 2 } },
    server: { port: 8017 },
  },
  deployments: [{ system_id: "jevos-a", proxmox: { host_id: "pve-c", lxc: { vmid: 423, ip_config: "10.0.0.23/24,gw=10.0.0.1" } } }],
};

describe("jevos deployments", () => {
  it("resolves --instance a", () => {
    const [d] = resolveJevosDeployments(cfg, { instance: "a" });
    expect(d.systemId).toBe("jevos-a");
    expect(d.install.release).toBe("jevos-v4");
  });
  it("summarizes ip and vault key", () => {
    const [s] = listJevosDeploymentSummaries(cfg);
    expect(s.ip).toBe("10.0.0.23");
    expect(s.api_key_vault_key).toBe("HDC_JEVOS_API_KEY");
  });
  it("rejects bad system ids and tiny memory", () => {
    expect(() => resolveJevosDeployments({ ...cfg, deployments: [{ system_id: "ct-jevos-a" }] }, {})).toThrow();
    const small = structuredClone(cfg);
    small.defaults.proxmox.lxc.memory_mb = 512;
    expect(() => resolveJevosDeployments(small, {})).toThrow(/memory_mb/);
  });
  it("dhcp has no ip", () => {
    expect(guestIpFromLxc({ ip_config: "dhcp" })).toBeNull();
  });
});

describe("jevos install script", () => {
  it("unit runs as non-root with restart always", () => {
    const u = buildJevosUnit({ host: "0.0.0.0", port: 8017 });
    expect(u).toContain("User=jevos");
    expect(u).toContain("Restart=always");
    expect(u).toContain("EnvironmentFile=/etc/jevos/jevos.env");
  });
  it("nftables restricts port to cidrs", () => {
    expect(buildJevosNftables(8017, ["10.0.0.0/8"])).toContain("tcp dport 8017 ip saddr { 10.0.0.0/8 } accept");
  });
  it("embeds key only in env heredoc and rejects unsafe keys", () => {
    const key = "A".repeat(43);
    const s = buildJevosInstallScript({}, { port: 8017 }, { apiKey: key });
    expect(s.split(key).length).toBe(2);
    expect(s).toContain("chmod 0600 /etc/jevos/jevos.env");
    expect(() => buildJevosInstallScript({}, {}, { apiKey: "bad key; rm -rf /" })).toThrow();
  });
});
