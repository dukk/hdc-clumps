# Dawarich (`dawarich`)

[Dawarich](https://dawarich.app/) — self-hosted location history (Google Timeline alternative) on Proxmox LXC (Docker Compose: PostGIS, Redis, app, Sidekiq). Default port **3000**.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and `dawarich.public_url` when using nginx-waf
- **Inventory:** `inventory/manual/systems/dawarich-a.json`; `inventory/manual/services/dawarich.json`
- **Vault:** `HDC_DAWARICH_SECRET_KEY_BASE`, `HDC_DAWARICH_DB_PASSWORD` (auto-generated on first deploy if missing)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Dawarich stack (`freikin/dawarich`) |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for four containers + `/api/v1/health` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service dawarich deploy -- --instance a
node apps/hdc-cli/cli.mjs run service dawarich query -- --live
node apps/hdc-cli/cli.mjs run service dawarich maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP / URL:** from deploy/query `url` or `upstream_url` (e.g. `http://192.0.2.153:3000` or `https://dawarich.example.invalid`).
2. **Inventory:** set `access.nodes[0].ip` on `dawarich-a.json`.
3. **First login:** change the default admin password in the web UI.
4. **Mobile:** point Dawarich or OwnTracks apps at your public URL.
5. **HTTPS:** set `dawarich.public_url`, add BIND + nginx-waf site (upstream `http://<ct-ip>:3000`, WebSockets on `/`).

## Related

- Schema: [`apps/hdc-cli/schema/dawarich.config.schema.json`](../../../apps/hdc-cli/schema/dawarich.config.schema.json)
- Upstream docs: https://dawarich.app/docs/self-hosting/introduction/
