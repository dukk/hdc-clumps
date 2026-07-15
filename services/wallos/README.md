# Wallos (`wallos`)

[Wallos](https://wallosapp.com/) — open-source personal subscription tracker on Proxmox LXC (Docker Compose, SQLite). Default LAN access: `http://<ct-ip>:8282`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `wallos.public_url` for future nginx-waf
- **Inventory:** `inventory/manual/systems/wallos-a.json`; `inventory/manual/services/wallos.json`
- **Vault:** none required for v1 — complete first-run admin setup in the web UI after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Wallos (`bellamy/wallos`) |
| `maintain` | Re-push `docker-compose.yml`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service wallos deploy -- --instance a
node apps/hdc-cli/cli.mjs run service wallos query -- --live
node apps/hdc-cli/cli.mjs run service wallos maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.136:8282`).
2. **Inventory:** set `access.nodes[0].ip` on `wallos-a.json`.
3. **Admin account:** complete first-run setup in the Wallos web UI.
4. **Data:** SQLite and logos persist under `/opt/wallos/db` and `/opt/wallos/logos` on the CT.
5. **HTTPS (optional):** set `wallos.public_url`, add BIND + nginx-waf upstream manually.

## Related

- [AGENTS.md — Wallos](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/wallos.config.schema.json`](../../../apps/hdc-cli/schema/wallos.config.schema.json)
