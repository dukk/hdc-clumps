# Apache Kafka (`kafka`)

Three-node KRaft cluster on Proxmox QEMU (no ZooKeeper).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `kafka.cluster_id` (UUID from `kafka-storage.sh random-uuid`)
- **Inventory:** [`inventory/manual/systems/vm-kafka-a.json`](../../../inventory/manual/systems/vm-kafka-a.json), [`vm-kafka-b.json`](../../../inventory/manual/systems/vm-kafka-b.json), [`vm-kafka-c.json`](../../../inventory/manual/systems/vm-kafka-c.json); [`inventory/manual/services/kafka.json`](../../../inventory/manual/services/kafka.json)
- **Vault:** none for v1 (PLAINTEXT listeners)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU clone, Kafka tarball, format storage, `kafka.service` |
| `maintain` | Re-push `server.properties`; rolling restart |
| `query` | `systemctl`; `kafka-broker-api-versions.sh` on localhost |

```bash
node apps/hdc-cli/cli.mjs run service kafka deploy --
node apps/hdc-cli/cli.mjs run service kafka query --
```

## Common flags

`--instance a|b|c`, `--destroy-existing`, `--skip-provision`, `--skip-existing`, `--dry-run`.

## After deploy

1. **Brokers:** connect clients to bootstrap URLs from `server.properties` / config (broker IPs and listener ports from your deployment).
2. **PLAINTEXT:** v1 has no TLS/auth — restrict network access accordingly.
3. No web UI; use Kafka CLI tools or your streaming apps.

## Related

- [AGENTS.md — Kafka](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/kafka.config.schema.json`](../../../apps/hdc-cli/schema/kafka.config.schema.json)
