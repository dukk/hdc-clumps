# Scanopy (`scanopy`)

Network discovery stack on Proxmox LXC via official Docker Compose in `/opt/scanopy`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/scanopy-a.json`](../../../inventory/manual/systems/scanopy-a.json); [`inventory/manual/services/scanopy.json`](../../../inventory/manual/services/scanopy.json)
- **Vault:** `HDC_SCANOPY_POSTGRES_PASSWORD`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Compose stack |
| `maintain` | `docker compose pull` + `up -d` |
| `query` | Config summary; `--live` for Docker/HTTP on port **60072** |
| `teardown` | Optional compose down, then destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service scanopy deploy --
node apps/hdc-cli/cli.mjs run service scanopy query -- --live
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-compose-down` (teardown), `--dry-run`, `--yes`.

## After deploy

1. Get IP from query (`--live`) or inventory.
2. **Web UI:** `http://<guest-ip>:60072`
3. Postgres password is in vault (`HDC_SCANOPY_POSTGRES_PASSWORD`) for the compose stack.

## Related

- [AGENTS.md — Scanopy](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/scanopy.config.schema.json`](../../../apps/hdc-cli/schema/scanopy.config.schema.json)
