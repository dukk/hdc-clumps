# Glances (`glances`)

[Glances](https://github.com/nicolargo/glances) — cross-platform system monitoring with a Web UI on Proxmox LXC (Docker Compose). Default LAN access: `http://<ct-ip>:61208`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `glances.public_url` for nginx-waf
- **Inventory:** `inventory/manual/systems/glances-a.json`; `inventory/manual/services/glances.json`
- **Vault:** none required for v1

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Glances (`nicolargo/glances:latest-full`, web server mode) |
| `maintain` | Re-push `docker-compose.yml`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for Docker + API health on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service glances deploy -- --instance a
node apps/hdc-cli/cli.mjs run service glances query -- --live
node apps/hdc-cli/cli.mjs run service glances maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.95:61208`).
2. **Inventory:** set `access.nodes[0].ip` on `glances-a.json`.
3. **HTTPS (optional):** set `glances.public_url`, add BIND A/CNAME records and nginx-waf site with `internal_only` (Web UI has no built-in auth).
4. **Browser mode:** set `glances.browser_mode: true` and re-run maintain to discover other Glances servers on the LAN.

## Related

- Schema: [`apps/hdc-cli/schema/glances.config.schema.json`](../../../apps/hdc-cli/schema/glances.config.schema.json)
