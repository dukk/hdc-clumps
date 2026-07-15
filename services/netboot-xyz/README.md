# netboot.xyz (`netboot-xyz`)

Self-hosted [netboot.xyz](https://netboot.xyz/docs) PXE boot server on Proxmox LXC via Docker Compose (`ghcr.io/netbootxyz/netbootxyz`).

The container provides a web UI for menus and asset mirroring, nginx for boot assets, and dnsmasq TFTP. **It does not run DHCP** — configure your existing LAN DHCP server to point PXE clients at this host.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (in hdc-private for production)
- **Inventory:** `inventory/manual/systems/netboot-xyz-a.json`; `inventory/manual/services/netboot-xyz.json`
- **Vault:** none for v1
- **DHCP:** separate server (UniFi, router, or dnsmasq) with `next-server` and boot filename — see [TFTP booting](https://netboot.xyz/docs/booting/tftp)

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 3000 | TCP | Web configuration UI |
| 69 | UDP | TFTP (iPXE boot files) |
| 8080 | TCP | HTTP boot assets (host → container nginx :80) |

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Compose |
| `maintain` | Re-push compose, `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for Docker/HTTP/TFTP probes + `dhcp_hints` |
| `teardown` | Optional compose down, then destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service netboot-xyz deploy -- --instance a
node apps/hdc-cli/cli.mjs run service netboot-xyz maintain --
node apps/hdc-cli/cli.mjs run service netboot-xyz query -- --live
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-clamav`, `--skip-admin-user`, `--skip-upgrade` (maintain), `--skip-compose-down` (teardown), `--dry-run`, `--yes`.

## Config notes

- **`netboot_xyz.menu_version`:** pin a netboot.xyz release tag (e.g. `2.0.84`); omit or `null` for latest on pull.
- **`netboot_xyz.tftpd_opts`:** passed as `TFTPD_OPTS` (default `--tftp-single-port`).
- **Disk:** default 128 GiB rootfs; `/assets` grows when mirroring ISOs in the web UI.

## After deploy

1. Open `http://<guest-ip>:3000` to manage menus.
2. Run `query --live` and use `dhcp_hints` in the JSON for your DHCP vendor.
3. PXE-boot a test machine on the LAN.

LAN-only for v1 — no nginx-waf or public HTTPS.

## hdc-private setup

1. Copy `config.example.json` to `hdc-private/clumps/services/netboot-xyz/config.json` (pick a free `vmid` and static IP from BIND).
2. Add inventory sidecars per manifest `inventory_docs`.

## Related

- [netboot.xyz docs](https://netboot.xyz/docs)
- [Docker container overview](https://netboot.xyz/docs/docker)
- Schema: [`apps/hdc-cli/schema/netboot-xyz.config.schema.json`](../../../apps/hdc-cli/schema/netboot-xyz.config.schema.json)
