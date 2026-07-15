# IT-Tools (`it-tools`)

[IT-Tools](https://github.com/CorentinTh/it-tools) — self-hosted collection of developer utilities on Proxmox LXC (Docker Compose). Default LAN access: `http://<ct-ip>:8080`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `it_tools.public_url` for future nginx-waf
- **Inventory:** `inventory/manual/systems/it-tools-a.json`; `inventory/manual/services/it-tools.json`
- **Vault:** none required for v1

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker IT-Tools (`corentinth/it-tools:latest`) |
| `maintain` | Re-push `docker-compose.yml`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service it-tools deploy -- --instance a
node apps/hdc-cli/cli.mjs run service it-tools query -- --live
node apps/hdc-cli/cli.mjs run service it-tools maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.141:8080`).
2. **Inventory:** set `access.nodes[0].ip` on `it-tools-a.json`.
3. **Usage:** open the web UI from the LAN — no accounts or setup wizard.
4. **HTTPS (optional):** set `it_tools.public_url`, add BIND + nginx-waf upstream manually.

## Related

- [AGENTS.md — IT-Tools](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/it-tools.config.schema.json`](../../../apps/hdc-cli/schema/it-tools.config.schema.json)
