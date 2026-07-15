# SolidTime (`solidtime`)

Deploy SolidTime time-tracking on Proxmox LXC (Ubuntu 22.04, Caddy, PHP, PostgreSQL).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/solidtime-a.json`](../../../inventory/manual/systems/solidtime-a.json); [`inventory/manual/services/solidtime.json`](../../../inventory/manual/services/solidtime.json)
- **Vault:** `HDC_SOLIDTIME_DB_PASSWORD` (optional — auto-generated on first deploy if missing)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + SolidTime from GitHub tarball |
| `maintain` | Upgrade to `solidtime.version` in config |
| `query` | Caddy/PHP/PostgreSQL/HTTP health |
| `teardown` | Destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service solidtime deploy --
node apps/hdc-cli/cli.mjs run service solidtime maintain -- --check-latest
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--version <tag>`, `--skip-upgrade`, `--dry-run`, `--yes` (teardown).

## After deploy

1. Get IP from query or inventory.
2. **Web UI:** `https://<guest-ip>` or URL from `solidtime.app_url` in config when set.
3. **First run:** register the first account in the web UI.

## Related

- [AGENTS.md — SolidTime](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/solidtime.config.schema.json`](../../../apps/hdc-cli/schema/solidtime.config.schema.json)
