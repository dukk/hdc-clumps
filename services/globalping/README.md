# Globalping probe (`globalping`)

[Globalping](https://globalping.io/) community network measurement probe on Proxmox LXC (Docker Compose, host networking). Adopt the probe in the [Globalping dashboard](https://dash.globalping.io/probes) via `GP_ADOPTION_TOKEN`.

Monitoring IP range: **Monitoring** group in `hdc-private/operations/ip-allocations.md` (instance IP is in hdc-private `config.json` and inventory).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`
- **Inventory:** `inventory/manual/systems/globalping-a.json`; `inventory/manual/services/globalping.json`
- **Vault:** `HDC_GLOBALPING_ADOPTION_TOKEN` (from Globalping dashboard → Probes → Adopt a probe → Software probe)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker `globalping/globalping-probe` (host network) |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for docker/probe container status |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_GLOBALPING_ADOPTION_TOKEN
node apps/hdc-cli/cli.mjs run service globalping deploy -- --instance a
node apps/hdc-cli/cli.mjs run service globalping query -- --live
node apps/hdc-cli/cli.mjs run service globalping maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. Confirm probe is **adopted** on the Globalping dashboard.
2. **BIND:** add `globalping-a` A record in hdc-private `clumps/services/bind/config.json` (IP from deploy output / `ip-allocations.md`; apply via `bind maintain`).
3. No nginx-waf — probe has no inbound web UI.

## Related

- [AGENTS.md — Globalping](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/globalping.config.schema.json`](../../../apps/hdc-cli/schema/globalping.config.schema.json)
