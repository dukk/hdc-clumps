# Paperless-ngx (`paperless-ngx`)

Self-hosted document management (OCR, tagging, search) on Proxmox LXC or QEMU Ubuntu VM via Docker Compose (PostgreSQL, Redis, optional Tika + Gotenberg). Based on the [official Paperless-ngx compose files](https://github.com/paperless-ngx/paperless-ngx/tree/main/docker/compose).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, static IP, and optional `paperless_ngx.public_url`
- **Inventory:** `inventory/manual/systems/paperless-ngx-a.json`; `inventory/manual/services/paperless-ngx.json`
- **Vault:** `HDC_PAPERLESS_SECRET_KEY` and `HDC_PAPERLESS_DB_PASSWORD` (auto-generated on first deploy if missing)
- **LXC:** privileged container with Docker (`unprivileged: 0`, `nesting=1,keyctl=1`)
- **QEMU:** Ubuntu template (`template_vmid` 9024), `configure.ssh.host`, cloud-init static `proxmox.qemu.ip`

## Stack modes

Set `paperless_ngx.tika_enabled` in config:

| Value | Services |
|-------|----------|
| `true` (default) | Redis, PostgreSQL, webserver, Gotenberg, Tika (Office/email conversion) |
| `false` | Redis, PostgreSQL, webserver only (PDF/image OCR built into Paperless) |

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC or QEMU + Docker Paperless stack |
| `maintain` | Re-push compose + env files; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for HTTP probe on port 8000 |
| `teardown` | Optional compose down, destroy LXC or QEMU guest |

```bash
node apps/hdc-cli/cli.mjs run service paperless-ngx deploy -- --instance a
node apps/hdc-cli/cli.mjs run service paperless-ngx deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service paperless-ngx query -- --live
node apps/hdc-cli/cli.mjs run service paperless-ngx maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--destroy-existing` (QEMU), `--skip-provision` (QEMU), `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## Document import

After deploy, copy files into the consume directory on the guest (default `/opt/paperless-ngx/consume`). Paperless watches this folder and imports automatically. Export directory: `/opt/paperless-ngx/export`.

## After deploy

1. **Guest IP / URL:** from deploy/query `upstream_url` (e.g. `http://192.0.2.152:8000`).
2. **Inventory:** set `access.nodes[0].ip` on `paperless-ngx-a.json`.
3. **Admin account:** enable `paperless_ngx.admin.enabled` before first deploy to auto-create a superuser, or run `docker compose exec webserver createsuperuser` in the compose dir.
4. **HTTPS (optional):** set `paperless_ngx.public_url` to `https://…`, add BIND A record and nginx-waf site upstream to `http://<guest-ip>:8000`. Increase `client_max_body_size` on the nginx-waf site for large document uploads.
5. **Backup:** preserve vault secrets and Docker volumes (`data`, `media`, `pgdata`, `redisdata`).

## Related

- [AGENTS.md — Paperless-ngx](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/paperless-ngx.config.schema.json`](../../../apps/hdc-cli/schema/paperless-ngx.config.schema.json)
- Upstream docs: [Paperless-ngx setup](https://docs.paperless-ngx.com/setup/)
