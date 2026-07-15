# YaCy (`yacy`)

Decentralized search engine on Proxmox LXC via Docker Compose (`yacy/yacy_search_server`).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (in hdc-private for production)
- **Inventory:** `inventory/manual/systems/yacy-a.json`, `yacy-b.json`; `inventory/manual/services/yacy.json`
- **Vault:** `HDC_YACY_ADMIN_PASSWORD` (applied via `passwd.sh` after the container starts)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Compose + admin password |
| `maintain` | `docker compose pull` + `up -d`; guest baseline; optional admin password re-apply |
| `query` | Config summary; `--live` for Docker/HTTP on port **8090** |
| `teardown` | Optional compose down, then destroy LXC |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_YACY_ADMIN_PASSWORD
node apps/hdc-cli/cli.mjs run service yacy deploy --
node apps/hdc-cli/cli.mjs run service yacy query -- --live
```

## Common flags

`--instance a` / `--instance b`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-admin-password`, `--skip-clamav`, `--skip-admin-user`, `--skip-compose-down` (teardown), `--dry-run`, `--yes`.

Multi-instance: omit `--instance` to deploy all entries in `deployments[]` (e.g. `yacy-a` on `pve-a`, `yacy-b` on `pve-b`).

## After deploy

1. Get IP from `query --live` or inventory.
2. **Web UI:** `http://<guest-ip>:8090` — admin user `admin`, password from vault.
3. Index data lives in the Docker volume under `/opt/yacy_search_server/DATA`; grow `rootfs_gb` if the index outgrows disk.

## Related

- [AGENTS.md — YaCy](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/yacy.config.schema.json`](../../../apps/hdc-cli/schema/yacy.config.schema.json)
