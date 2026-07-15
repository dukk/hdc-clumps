# OpenSpeedTest (`openspeedtest`)

[OpenSpeedTest](https://openspeedtest.com/) — self-hosted HTML5 LAN/WAN speed test on Proxmox LXC (Docker Compose). Default LAN access: `http://<ct-ip>:3000`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `openspeedtest.public_url` for future nginx-waf
- **Inventory:** `inventory/manual/systems/openspeedtest-a.json`; `inventory/manual/services/openspeedtest.json`
- **Vault:** none required for v1

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker OpenSpeedTest (`openspeedtest/latest`) |
| `maintain` | Re-push `docker-compose.yml`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service openspeedtest deploy -- --instance a
node apps/hdc-cli/cli.mjs run service openspeedtest query -- --live
node apps/hdc-cli/cli.mjs run service openspeedtest maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.138:3000`).
2. **Inventory:** set `access.nodes[0].ip` on `openspeedtest-a.json`.
3. **Usage:** open the web UI and click Start to measure download/upload on your LAN.
4. **HTTPS (optional):** set `openspeedtest.public_url`, add BIND + nginx-waf upstream manually.

## Related

- [AGENTS.md — OpenSpeedTest](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/openspeedtest.config.schema.json`](../../../apps/hdc-cli/schema/openspeedtest.config.schema.json)
