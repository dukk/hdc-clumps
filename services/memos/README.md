# Memos (`memos`)

[Memos](https://usememos.com/) — open-source, self-hosted notes on Proxmox LXC (Docker Compose, SQLite). Default LAN access: `http://<ct-ip>:5230`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `memos.public_url` for future nginx-waf
- **Inventory:** `inventory/manual/systems/memos-a.json`; `inventory/manual/services/memos.json`
- **Vault:** none required for v1 — create the first account in the Memos web UI after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Memos (`neosmemo/memos`) |
| `maintain` | Re-push `docker-compose.yml`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service memos deploy -- --instance a
node apps/hdc-cli/cli.mjs run service memos query -- --live
node apps/hdc-cli/cli.mjs run service memos maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.151:5230`).
2. **Inventory:** set `access.nodes[0].ip` on `memos-a.json`.
3. **First account:** sign up in the Memos web UI (first user becomes admin).
4. **Data:** SQLite and assets persist under `/opt/memos/data` on the CT.
5. **HTTPS (optional):** set `memos.public_url`, add BIND + nginx-waf upstream manually.

## Related

- [AGENTS.md — Memos](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/memos.config.schema.json`](../../../apps/hdc-cli/schema/memos.config.schema.json)
