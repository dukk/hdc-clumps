# CloudBeaver (`cloudbeaver`)

[CloudBeaver Community](https://github.com/dbeaver/cloudbeaver) — web database manager on Proxmox LXC (Docker Compose). Default LAN access: `http://<ct-ip>:8978`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `cloudbeaver.public_url` for future nginx-waf
- **Inventory:** `inventory/manual/systems/cloudbeaver-a.json`; `inventory/manual/services/cloudbeaver.json`
- **Vault:** `HDC_CLOUDBEAVER_ADMIN_PASSWORD` (auto-generated on first deploy if missing)

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_CLOUDBEAVER_ADMIN_PASSWORD
```

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker CloudBeaver (`dbeaver/cloudbeaver:latest`) |
| `maintain` | Re-push `docker-compose.yml` + `.env`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service cloudbeaver deploy -- --instance a
node apps/hdc-cli/cli.mjs run service cloudbeaver query -- --live
node apps/hdc-cli/cli.mjs run service cloudbeaver maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.140:8978`).
2. **Inventory:** set `access.nodes[0].ip` on `cloudbeaver-a.json`.
3. **Login:** username from `cloudbeaver.admin.username` (default `cbadmin`); password from vault.
4. **Database connections:** add in the UI. Use `host.docker.internal` (enabled via `extra_hosts`) or a LAN IP for PostgreSQL/MySQL on other guests.
5. **HTTPS (optional):** set `cloudbeaver.public_url`, add BIND + nginx-waf upstream with `internal_only` access — CloudBeaver is a full DB admin surface.

## Security

Keep CloudBeaver on the LAN unless you explicitly expose it behind nginx-waf with strict access controls. Workspace data (saved connections, scripts) persists under `/opt/cloudbeaver/workspace` on the CT.

## Related

- Schema: [`apps/hdc-cli/schema/cloudbeaver.config.schema.json`](../../../apps/hdc-cli/schema/cloudbeaver.config.schema.json)
- Upstream: [CloudBeaver Community Docker](https://github.com/dbeaver/cloudbeaver/wiki/CloudBeaver-Community-deployment-from-docker-image)
