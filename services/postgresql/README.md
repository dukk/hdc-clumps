# PostgreSQL (`postgresql`)

Deploy PostgreSQL on Proxmox QEMU: standalone, primary, or standby with replication.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/vm-postgres-a.json`](../../../inventory/manual/systems/vm-postgres-a.json), [`vm-postgres-b.json`](../../../inventory/manual/systems/vm-postgres-b.json); [`inventory/manual/services/postgresql.json`](../../../inventory/manual/services/postgresql.json)
- **Vault:** `HDC_POSTGRESQL_SUPERUSER_PASSWORD` (required); `HDC_POSTGRESQL_REPLICATION_PASSWORD` when any deployment has `role: standby`; optional per-instance `_A`, `_B`, …

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU clone, cloud-init, apt PostgreSQL over SSH |
| `maintain` | Re-apply config; optional package upgrade |
| `query` | Service status, `pg_isready`, version, replication lag |

```bash
node apps/hdc-cli/cli.mjs run service postgresql deploy -- --instance a
node apps/hdc-cli/cli.mjs run service postgresql query --
```

## Common flags

`--instance a|b`, `--destroy-existing`, `--skip-provision`, `--skip-install`, `--skip-package-upgrade` (maintain), `--skip-clamav`, `--dry-run`.

## After deploy

1. **Port:** **5432** on each node IP.
2. **Connect:** `psql -h <guest-ip> -U postgres` (password in vault).
3. Deploy **primary/standalone before standby**.
4. No web UI; use your SQL client or app connection strings.

## Related

- [AGENTS.md — PostgreSQL](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/postgresql.config.schema.json`](../../../apps/hdc-cli/schema/postgresql.config.schema.json)
