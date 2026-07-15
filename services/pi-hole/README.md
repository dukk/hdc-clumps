# Pi-hole DNS filtering (`pi-hole`)

Deploy Pi-hole on Proxmox LXC (multi-instance), sync allowlist exceptions, update blocklists, and query status.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (in hdc-private for production)
- **Inventory:** optional [`inventory/manual/systems/pi-hole-a.json`](../../../inventory/manual/systems/pi-hole-a.json), [`pi-hole-b.json`](../../../inventory/manual/systems/pi-hole-b.json)
- **Secrets:** set `defaults.pihole.webpassword` and `defaults.proxmox.lxc.password` in config (non-interactive deploy). Optional vault: `webpassword_vault_key` / `HDC_PIHOLE_API_TOKEN` for API query later.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision + unattended Pi-hole install + allowlist sync |
| `maintain` | Re-apply config/allowlist; gravity update; optional core update; `--apply-network` to set static `ip_config` on existing CTs |
| `query` | Per-instance status via `pct exec`; `--live` compares configured vs live allowlist |

```bash
node apps/hdc-cli/cli.mjs run service pi-hole deploy --
node apps/hdc-cli/cli.mjs run service pi-hole maintain --
node apps/hdc-cli/cli.mjs run service pi-hole query -- --live
```

## Allowlist (exceptions)

Add domains under `defaults.pihole.allowlist[]` (or per-deployment override). Deploy and maintain run `pihole allow` on each instance so listed domains bypass blocklists.

```json
"allowlist": [
  "marketingplatform.google.com",
  { "domain": "www.googletagmanager.com", "comment": "Google Analytics / GTM" }
]
```

This is **not** the same as `local_dns[]` (custom A records). Allowlist entries only stop Pi-hole from blocking those hostnames.

**Google Analytics:** the example bundle includes `marketingplatform.google.com`, GTM, and common GA hostnames. Browser privacy extensions may still block tracking scripts even when DNS is allowed.

| Flag | Effect |
|------|--------|
| `--skip-allowlist` | Skip allowlist sync (gravity-only maintain) |
| `--prune` | Remove allowlist entries not in config (maintain only; may delete UI-added entries) |

## Common flags

`--instance a|b`, `--system-id pi-hole-b`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-core-update` (maintain), `--apply-network` (maintain: stop CT, set Proxmox `net0` from `proxmox.lxc.ip_config` or `ip` + `proxmox.network.gateway`), `--webpassword` (override config), `--dry-run`, `--no-report`.

Static IP in config: use `deployments[].proxmox.lxc.ip_config` as `192.0.2.4/24,gw=192.0.2.1` (or `ip: 192.0.2.4/24` with `defaults.proxmox.network.gateway`). Not the QEMU-style `ip` field alone on deploy without gateway.

**Multi-VLAN DNS:** Set `defaults.pihole.listening_mode` to `ALL` (default in `config.example.json`) so clients outside the Pi-hole subnet (e.g. `192.0.2.0/24`) can query Pi-hole. `LOCAL` only answers for the same subnet as the CT.

## After deploy

1. Get IP: `node apps/hdc-cli/cli.mjs run service pi-hole query --` or set `access.nodes[].ip` in inventory sidecars.
2. **Web admin:** `http://<guest-ip>/admin` (password from `pihole.webpassword` in config).
3. **DNS:** point clients or DHCP (e.g. UniFi) at both Pi-hole IPs for redundancy.

## Related

- [AGENTS.md — Pi-hole](../../../AGENTS.md)
