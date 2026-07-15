# Apache Cassandra (`cassandra`)

Three-node Cassandra cluster on Proxmox QEMU VMs (seeds first).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/vm-cassandra-a.json`](../../../inventory/manual/systems/vm-cassandra-a.json), [`vm-cassandra-b.json`](../../../inventory/manual/systems/vm-cassandra-b.json), [`vm-cassandra-c.json`](../../../inventory/manual/systems/vm-cassandra-c.json); [`inventory/manual/services/cassandra.json`](../../../inventory/manual/services/cassandra.json)
- **Vault:** `HDC_CASSANDRA_SUPERUSER_PASSWORD` when `cassandra.authenticator` is `PasswordAuthenticator`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU clone + apt Cassandra; bootstrap order a→b→c |
| `maintain` | Re-push yaml/JVM; optional `--rolling-restart` |
| `query` | Service status; `nodetool status` |

```bash
node apps/hdc-cli/cli.mjs run service cassandra deploy -- --destroy-existing
node apps/hdc-cli/cli.mjs run service cassandra query --
```

## Common flags

`--instance a|b|c`, `--destroy-existing`, `--skip-provision`, `--rolling-restart`, `--skip-clamav`, `--dry-run`.

## After deploy

1. **CQL native transport:** port **9042** on seed/contact node IPs (from config).
2. **Ops:** `nodetool status` via query output or SSH on a node.
3. Connect with `cqlsh` or application drivers using credentials from vault when auth is enabled.

## Related

- [AGENTS.md — Cassandra](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/cassandra.config.schema.json`](../../../apps/hdc-cli/schema/cassandra.config.schema.json)
