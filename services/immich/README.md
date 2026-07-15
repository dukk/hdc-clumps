# Immich (`immich`)

Self-hosted photo and video library from the official Immich Docker Compose release. Deploy on **Synology** (`synology-docker`) or **Proxmox QEMU** (`proxmox-qemu`); optional public HTTPS via nginx-waf when `immich.public_url` is set.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (in hdc-private for production)
- **Inventory:** [`inventory/manual/systems/immich-a.json`](../../../inventory/manual/systems/immich-a.json) (NAS Docker), optional [`vm-immich-a.json`](../../../inventory/manual/systems/vm-immich-a.json) (QEMU); [`inventory/manual/services/immich.json`](../../../inventory/manual/services/immich.json)
- **Vault:** `HDC_IMMICH_DB_PASSWORD` (required for deploy/maintain); `HDC_IMMICH_API_KEY` (admin API — create in Immich UI with `systemConfig.read` + `systemConfig.update`)
- **Synology:** run `synology-nas maintain` first; set `synology.instance` and paths under `/volume1/docker/immich/`
- **HTTPS:** nginx-waf `sites[]` upstream to `http://<host>:2283`; BIND or Cloudflare A record when exposing publicly

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Synology compose stack or Proxmox QEMU clone + SSH install |
| `maintain` | Re-push `.env`; `docker compose pull` + `up -d`; admin sync via Immich API (`--skip-admin-sync`, `--test-email`); ClamAV on Proxmox guests (`--skip-clamav`) |
| `query` | Config summary; `--live` for compose health; `--admin` / `--import --yes` for `system_config` drift and import (single deployment) |
| `teardown` | Synology or Proxmox: optional compose down then destroy guest |

```bash
node apps/hdc-cli/cli.mjs run service immich deploy -- --instance a
node apps/hdc-cli/cli.mjs run service immich query -- --system-id vm-immich-a --import --yes
node apps/hdc-cli/cli.mjs run service immich maintain -- --system-id vm-immich-a
node apps/hdc-cli/cli.mjs run service immich query -- --system-id vm-immich-a --admin
```

## Common flags

`--instance a`, `--system-id`, `--destroy-existing` (QEMU), `--skip-provision`, `--skip-install`, `--skip-upgrade` (maintain), `--skip-admin-sync` (maintain), `--test-email <addr>` (maintain), `--skip-clamav` (maintain), `--live` (query), `--admin` / `--import` / `--yes` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## Config

- `immich.port` — default `2283` (compose publish port)
- `immich.public_url` — e.g. `https://immich.example.org` for `IMMICH_SERVER_URL` and admin `server.externalDomain`
- `immich.api_key_vault_key` — vault env name for admin API (default `HDC_IMMICH_API_KEY`)
- `immich.mail.enabled` — when true, maintain sets `notifications.smtp` to internal postfix-relay (`postfix-relay.home.example.invalid:25`, no auth)
- `immich.system_config` — sanitized admin config from `query --import`; maintain deep-merges over live via `PUT /api/system-config`
- `immich.upload_location` / `immich.db_data_location` — library and Postgres data paths
- **Synology:** `mode: synology-docker`, `install.compose_dir` under `/volume1/docker/immich`
- **Proxmox:** `mode: proxmox-qemu`, optional `data_disk_gb` for library storage; set `configure.ssh.host` after deploy

## After deploy

1. **Web UI:** `http://<guest-ip>:2283` (or NAS IP on Synology). Register the first admin account in the browser.
2. **Health:** `GET /api/server/ping` on the same port (`query --live`).
3. **Public HTTPS:** set `immich.public_url`, add nginx-waf site upstream to port 2283, publish DNS to the WAF WAN IP.
4. **Inventory:** set `access.nodes[0].ip` on the deployment system sidecar from query output.

## Related

- [AGENTS.md — Immich](../../../AGENTS.md)
- [nginx-waf README](../nginx-waf/README.md)
- [synology-nas README](../../infrastructure/synology-nas/README.md)
- Schema: [`apps/hdc-cli/schema/immich.config.schema.json`](../../../apps/hdc-cli/schema/immich.config.schema.json)
