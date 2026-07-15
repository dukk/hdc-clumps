# SearXNG (`searxng`)

Privacy-focused metasearch on Proxmox LXC via Docker Compose (official `searxng` + `valkey` stack).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (in hdc-private for production)
- **Inventory:** `inventory/manual/systems/searxng-a.json`; `inventory/manual/services/searxng.json`
- **Vault:** `HDC_SEARXNG_SECRET` (auto-generated on first deploy if missing)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Compose |
| `maintain` | Re-push `.env` + `settings.yml`, `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for Docker/HTTP on port **8080** |
| `teardown` | Optional compose down, then destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service searxng deploy --
node apps/hdc-cli/cli.mjs run service searxng maintain --
node apps/hdc-cli/cli.mjs run service searxng query -- --live
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-clamav`, `--skip-admin-user`, `--skip-upgrade` (maintain), `--skip-compose-down` (teardown), `--dry-run`, `--yes`.

## After deploy

1. Get IP from `query --live` or inventory.
2. **Web UI:** `http://<guest-ip>:8080` on the LAN.
3. For public HTTPS later, set `searxng.public_url` in config and add BIND + nginx-waf upstream manually.

## hdc-private setup

1. Copy `config.example.json` to `hdc-private/clumps/services/searxng/config.json` (pick a free `vmid` and static IP).
2. Add `inventory/manual/systems/searxng-a.json` and `inventory/manual/services/searxng.json` (see manifest `inventory_docs`).

## Related

- [AGENTS.md — SearXNG](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/searxng.config.schema.json`](../../../apps/hdc-cli/schema/searxng.config.schema.json)
