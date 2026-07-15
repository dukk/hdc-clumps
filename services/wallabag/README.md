# Wallabag (`wallabag`)

Self-hosted read-it-later on Proxmox LXC (Docker Compose + MariaDB + Redis). LAN HTTPS via **nginx-waf** using `wallabag.public_url` (`internal-lan`).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, `wallabag.public_url`
- **Inventory:** `inventory/manual/systems/wallabag-a.json`; `inventory/manual/services/wallabag.json`
- **Vault:** `HDC_WALLABAG_DB_PASSWORD` and `HDC_WALLABAG_SECRET` (auto-generated on first deploy if missing)
- **nginx-waf:** reverse-proxy site after deploy (LAN-only)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Wallabag + MariaDB + Redis |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for HTTP probe |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service wallabag deploy -- --instance a
node apps/hdc-cli/cli.mjs run service wallabag query -- --live
node apps/hdc-cli/cli.mjs run service wallabag maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.154:80`).
2. **Inventory:** set `access.nodes[0].ip` on `wallabag-a.json`.
3. **BIND:** A `wallabag-a` → CT IP; CNAME `wallabag` → `nginx-waf-a.hdc.dukk.org.`
4. **nginx-waf:** site → `http://<ct-ip>:80` with `internal-lan`.
5. **First admin:** create account in the Wallabag web UI.
6. **Backup:** preserve `HDC_WALLABAG_DB_PASSWORD` and Docker volumes.

## Related

- Schema: [`apps/hdc-cli/schema/wallabag.config.schema.json`](../../../apps/hdc-cli/schema/wallabag.config.schema.json)
