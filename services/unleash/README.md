# Unleash (`unleash`)

Self-hosted [Unleash](https://github.com/Unleash/unleash) feature-flag server on Proxmox LXC (Docker Compose + PostgreSQL). Public HTTPS access is typically via **nginx-waf** using `unleash.public_url` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, optional static `ip_config`, and `unleash.public_url` when using nginx-waf
- **Inventory:** `inventory/manual/systems/unleash-a.json`; `inventory/manual/services/unleash.json`
- **Vault:** `HDC_UNLEASH_ADMIN_PASSWORD` (required before deploy); `HDC_UNLEASH_DB_PASSWORD` (auto-generated on first deploy if missing)
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:4242` after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Unleash + PostgreSQL |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for `/health` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service unleash deploy -- --instance a
node apps/hdc-cli/cli.mjs run service unleash query -- --live
node apps/hdc-cli/cli.mjs run service unleash maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.123:4242`).
2. **Inventory:** set `access.nodes[0].ip` on `unleash-a.json`.
3. **BIND / Cloudflare:** A record for the hostname in `unleash.public_url` when used.
4. **nginx-waf:** add a site with `proxy_pass` to the CT upstream.
5. **Login:** use `unleash.admin_user` (default `admin`) and the vault admin password. `UNLEASH_DEFAULT_ADMIN_*` env vars apply only on first DB init; change password later in the UI.
6. **SDK URLs:** backend `http://<host>:4242/api/`; frontend `http://<host>:4242/api/frontend/` — create API tokens in the Unleash admin UI.
7. **Backup:** preserve `HDC_UNLEASH_DB_PASSWORD` and the Docker volume (`unleash-data`).

## Related

- Schema: [`apps/hdc-cli/schema/unleash.config.schema.json`](../../../apps/hdc-cli/schema/unleash.config.schema.json)
- Upstream: [Unleash/unleash](https://github.com/Unleash/unleash)
