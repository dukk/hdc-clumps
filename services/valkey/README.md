# Valkey Cluster (`valkey`)

Three-master Valkey cluster on Proxmox QEMU VMs with cluster bootstrap via `valkey-cli --cluster create`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/vm-valkey-a.json`](../../../inventory/manual/systems/vm-valkey-a.json), [`vm-valkey-b.json`](../../../inventory/manual/systems/vm-valkey-b.json), [`vm-valkey-c.json`](../../../inventory/manual/systems/vm-valkey-c.json); [`inventory/manual/services/valkey.json`](../../../inventory/manual/services/valkey.json)
- **Vault:** `HDC_VALKEY_PASSWORD` (required)
- **Guests:** Ubuntu 24.04+ (or another release with `valkey` in default apt)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU + apt Valkey; cluster create when all nodes deploy |
| `maintain` | Re-apply `valkey.conf`; optional apt upgrade; cluster check |
| `query` | Per-node `PING`, `CLUSTER INFO`; full cluster check when all three configured |

```bash
node apps/hdc-cli/cli.mjs run service valkey deploy --
node apps/hdc-cli/cli.mjs run service valkey maintain --
```

## Common flags

`--instance a|b|c`, `--destroy-existing`, `--skip-provision`, `--skip-cluster-bootstrap`, `--skip-install`, `--skip-apt`, `--skip-clamav`, `--dry-run`, `--no-report`, `--report <path>`.

## After deploy

1. **Port:** **6379** on each node; use cluster-aware clients with the password from vault.
2. **Verify:** `node apps/hdc-cli/cli.mjs run service valkey query --` for cluster state.
3. No web UI.

## Related

- [AGENTS.md — Valkey](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/valkey.config.schema.json`](../../../apps/hdc-cli/schema/valkey.config.schema.json)
