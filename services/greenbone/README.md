# Greenbone (`greenbone`)

Greenbone Community Edition deployment on privileged Proxmox LXC via Docker Compose.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/greenbone-a.json`](../../../inventory/manual/systems/greenbone-a.json), [`inventory/manual/services/greenbone.json`](../../../inventory/manual/services/greenbone.json)
- **Vault:** `HDC_GREENBONE_ADMIN_PASSWORD`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Compose Greenbone CE |
| `maintain` | Re-push env/compose and refresh images |
| `query` | Config summary; `--live` for compose and HTTP probe |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_GREENBONE_ADMIN_PASSWORD
node apps/hdc-cli/cli.mjs run service greenbone deploy --
node apps/hdc-cli/cli.mjs run service greenbone query -- --live
```

## Bootstrap note

The first bootstrap can take a long time because Greenbone feeds and scanner data initialize in the background.
Keep the service running and re-check with `query -- --live` until health checks stabilize.

## Migrating from `openvas`

If upgrading from the former `openvas` package on a live CT:

1. Copy vault keys: `HDC_OPENVAS_ADMIN_PASSWORD` → `HDC_GREENBONE_ADMIN_PASSWORD` (and `HDC_USER_HDC_PASSWORD_OPENVAS_A` → `HDC_USER_HDC_PASSWORD_GREENBONE_A` if guest baseline ran).
2. On the CT: `cd /opt/openvas && docker compose down` (no `-v`), note the Docker volume name, `mv /opt/openvas /opt/greenbone`.
3. Run `node apps/hdc-cli/cli.mjs run service greenbone maintain --`.
4. If the stack starts with an empty volume, patch `/opt/greenbone/docker-compose.yml` once to use `external: true` on `greenbone-data` pointing at the old volume name, then re-run maintain.
5. Update BIND, homepage, and run `proxmox maintain -- --prune` to refresh backup job ids.

## Related

- [AGENTS.md — Greenbone section](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/greenbone.config.schema.json`](../../../apps/hdc-cli/schema/greenbone.config.schema.json)
