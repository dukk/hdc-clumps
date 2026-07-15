# Rackula (`rackula`)

[Rackula](https://github.com/RackulaLives/Rackula) — open-source drag-and-drop server rack layout designer on Proxmox LXC (Docker Compose with persistence). Default LAN access: `http://<ct-ip>:8080`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `rackula.public_url` for future nginx-waf
- **Inventory:** `inventory/manual/systems/rackula-a.json`; `inventory/manual/services/rackula.json`
- **Vault:** optional `HDC_RACKULA_API_WRITE_TOKEN` when `rackula.api_write_token_enabled` is true (protects API PUT/DELETE)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Rackula (`rackula:persist` + `rackula-api`) |
| `maintain` | Re-push `docker-compose.yml` + `.env`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for Docker + HTTP probe on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service rackula deploy -- --instance a
node apps/hdc-cli/cli.mjs run service rackula query -- --live
node apps/hdc-cli/cli.mjs run service rackula maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.156:8080`).
2. **Inventory:** set `access.nodes[0].ip` on `rackula-a.json`.
3. **Data:** layouts persist as YAML under `/opt/rackula/data` (owned by UID 1001).
4. **HTTPS (optional):** set `rackula.public_url`, add BIND + nginx-waf upstream manually.

## Related

- [AGENTS.md — Rackula](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/rackula.config.schema.json`](../../../apps/hdc-cli/schema/rackula.config.schema.json)
- Upstream self-hosting: [Rackula SELF-HOSTING.md](https://github.com/RackulaLives/Rackula/blob/main/docs/guides/SELF-HOSTING.md)
