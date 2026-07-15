# Shlink (`shlink`)

Self-hosted URL shortener on Proxmox LXC (Docker Compose + PostgreSQL + Redis + optional web client). Public HTTPS is typically via **nginx-waf** using `shlink.public_url` and `shlink.default_domain` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, `shlink.default_domain`, `shlink.public_url`, and optional `shlink.web_client.public_url`
- **Inventory:** `inventory/manual/systems/shlink-a.json`; `inventory/manual/services/shlink.json`
- **Vault:** `HDC_SHLINK_DB_PASSWORD` and `HDC_SHLINK_INITIAL_API_KEY` (auto-generated on first deploy if missing); optional `HDC_SHLINK_GEOLITE_LICENSE_KEY`
- **nginx-waf:** reverse-proxy sites for the short/API host and web client host after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Shlink + PostgreSQL + Redis (+ web client) |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for `/rest/health` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service shlink deploy -- --instance a
node apps/hdc-cli/cli.mjs run service shlink query -- --live
node apps/hdc-cli/cli.mjs run service shlink maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.x:8080`).
2. **Inventory:** set `access.nodes[0].ip` on `shlink-a.json`.
3. **BIND / Cloudflare:** A records for `shlink.default_domain` and `shlink.web_client.public_url` when used.
4. **nginx-waf:** short/API site → `http://<ct-ip>:8080`; web client site → `http://<ct-ip>:8081`.
5. **API key:** use vault `HDC_SHLINK_INITIAL_API_KEY` for the web UI and REST API.
6. **GeoLite:** optional `HDC_SHLINK_GEOLITE_LICENSE_KEY` then `maintain` for visit geolocation.
7. **Backup:** preserve `HDC_SHLINK_DB_PASSWORD` and Docker volumes (`shlink-db-data`, `shlink-redis-data`).

## Related

- [AGENTS.md — Shlink](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/shlink.config.schema.json`](../../../apps/hdc-cli/schema/shlink.config.schema.json)
