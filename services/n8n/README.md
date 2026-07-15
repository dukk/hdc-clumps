# n8n (`n8n`)

Workflow automation on Proxmox LXC (Docker Compose, SQLite). Public HTTPS access is typically via **nginx-waf** using `n8n.public_url` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, optional static `ip_config`, and `n8n.public_url` when using nginx-waf
- **Inventory:** `inventory/manual/systems/n8n-a.json`; `inventory/manual/services/n8n.json`
- **Vault:** `HDC_N8N_ENCRYPTION_KEY` (auto-generated on first deploy if missing)
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:5678` after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker n8n (SQLite) |
| `maintain` | Re-push `.env`; `docker compose pull` + `up -d`; ClamAV |
| `query` | Config summary; `--live` for `/healthz` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service n8n deploy -- --instance a
node apps/hdc-cli/cli.mjs run service n8n query -- --live
node apps/hdc-cli/cli.mjs run service n8n maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.123:5678`).
2. **Inventory:** set `access.nodes[0].ip` on `n8n-a.json`.
3. **BIND / Cloudflare:** A record for the hostname in `n8n.public_url` when used.
4. **nginx-waf:** add a site with `proxy_pass` to the CT upstream; enable WebSockets for n8n.
5. **Owner account:** complete first-run setup in the web UI.
6. **Backup:** preserve `HDC_N8N_ENCRYPTION_KEY` and the Docker volume (`n8n_data`).

## Related

- [AGENTS.md — n8n](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/n8n.config.schema.json`](../../../apps/hdc-cli/schema/n8n.config.schema.json)
- **Operator workflows** (hdc-private): `clumps/services/n8n/workflows/` — e.g. `humble-bundle-ebooks/` for weekly Humble Bundle → NAS → Audiobookshelf sync
