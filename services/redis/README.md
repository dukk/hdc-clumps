# Redis Cluster (`redis`)

Three-master Redis cluster on Proxmox QEMU VMs with cluster bootstrap via `redis-cli --cluster create`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/vm-redis-a.json`](../../../inventory/manual/systems/vm-redis-a.json), [`vm-redis-b.json`](../../../inventory/manual/systems/vm-redis-b.json), [`vm-redis-c.json`](../../../inventory/manual/systems/vm-redis-c.json); [`inventory/manual/services/redis.json`](../../../inventory/manual/services/redis.json)
- **Vault:** `HDC_REDIS_PASSWORD` (required)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU + apt Redis; cluster create when all nodes deploy |
| `maintain` | Re-apply `redis.conf`; optional apt upgrade; cluster check |
| `query` | Per-node `PING`, `CLUSTER INFO`; full cluster check when all three configured |

```bash
node apps/hdc-cli/cli.mjs run service redis deploy --
node apps/hdc-cli/cli.mjs run service redis maintain --
```

## Common flags

`--instance a|b|c`, `--destroy-existing`, `--skip-provision`, `--skip-cluster-bootstrap`, `--skip-apt`, `--skip-clamav`, `--dry-run`.

## After deploy

1. **Port:** **6379** on each node; use cluster-aware clients with the password from vault.
2. **Verify:** `node apps/hdc-cli/cli.mjs run service redis query --` for cluster state.
3. No web UI.

## Related

- [AGENTS.md — Redis](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/redis.config.schema.json`](../../../apps/hdc-cli/schema/redis.config.schema.json)
