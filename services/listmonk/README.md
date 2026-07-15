# Listmonk (`listmonk`)

Self-hosted newsletter and mailing list manager on Proxmox LXC (Docker Compose + PostgreSQL). Public HTTPS access is typically via **nginx-waf** using `listmonk.public_url` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, optional static `ip_config`, and `listmonk.public_url` when using nginx-waf
- **Inventory:** `inventory/manual/systems/listmonk-a.json`; `inventory/manual/services/listmonk.json`
- **Vault:** `HDC_LISTMONK_ADMIN_PASSWORD` (required before deploy); `HDC_LISTMONK_DB_PASSWORD` (auto-generated on first deploy if missing)
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:9000` after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Listmonk + PostgreSQL |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for `/api/health` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service listmonk deploy -- --instance a
node apps/hdc-cli/cli.mjs run service listmonk query -- --live
node apps/hdc-cli/cli.mjs run service listmonk maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.123:9000`).
2. **Inventory:** set `access.nodes[0].ip` on `listmonk-a.json`.
3. **BIND / Cloudflare:** A record for the hostname in `listmonk.public_url` when used.
4. **nginx-waf:** add a site with `proxy_pass` to the CT upstream.
5. **Login:** use `listmonk.admin_user` (default `admin`) and the vault admin password.
6. **SMTP:** set `listmonk.mail.enabled` in config for postfix-relay env vars, or configure in Admin -> Settings -> SMTP.
7. **Backup:** preserve `HDC_LISTMONK_DB_PASSWORD` and the Docker volume (`listmonk-data`).

## Related

- [AGENTS.md — Listmonk](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/listmonk.config.schema.json`](../../../apps/hdc-cli/schema/listmonk.config.schema.json)
