# Gatus health dashboard (`gatus`)

Lightweight health dashboard on Proxmox LXC; endpoints from `gatus.endpoints[]` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `gatus.version` (e.g. `v5.36.0`) and `gatus.endpoints[]`
- **Inventory:** [`inventory/manual/systems/gatus-a.json`](../../../inventory/manual/systems/gatus-a.json); [`inventory/manual/services/gatus.json`](../../../inventory/manual/services/gatus.json)
- **Vault:** optional — alerting tokens in `config_yaml_extra` via `${ENV}` (store in vault)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Gatus binary from GitHub release |
| `maintain` | Re-push `config.yaml`; optional binary upgrade |
| `query` | Config summary; `--live` for systemd + HTTP on port **8080** |
| `teardown` | Destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service gatus deploy --
node apps/hdc-cli/cli.mjs run service gatus query -- --live
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--dry-run`, `--yes`.

## After deploy

1. Open **`http://<guest-ip>:8080`** and verify endpoint checks.
2. Update `access.nodes[0].ip` on `inventory/manual/systems/gatus-a.json` from query output when the IP is known.

## Related

- [AGENTS.md — Gatus](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/gatus.config.schema.json`](../../../apps/hdc-cli/schema/gatus.config.schema.json)
