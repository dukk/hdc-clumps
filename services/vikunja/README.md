# Vikunja (`vikunja`)

Self-hosted task manager on Proxmox LXC (Docker Compose + PostgreSQL). Public HTTPS access is typically via **nginx-waf** using `vikunja.public_url` in config (must include trailing slash).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, optional static `ip_config`, and `vikunja.public_url`
- **Inventory:** `inventory/manual/systems/vikunja-a.json`; `inventory/manual/services/vikunja.json`
- **Vault:** `HDC_VIKUNJA_JWT_SECRET` and `HDC_VIKUNJA_DB_PASSWORD` (auto-generated on first deploy if missing)
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:3456` with WebSockets enabled

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Vikunja + PostgreSQL |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for `/api/v1/info` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service vikunja deploy -- --instance a
node apps/hdc-cli/cli.mjs run service vikunja query -- --live
node apps/hdc-cli/cli.mjs run service vikunja maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.123:3456`).
2. **Inventory:** set `access.nodes[0].ip` on `vikunja-a.json`.
3. **BIND / Cloudflare:** A record for the hostname in `vikunja.public_url`.
4. **nginx-waf:** add a site with `proxy_pass` to the CT upstream; enable WebSockets.
5. **First user:** register an account in the Vikunja web UI (no pre-seeded admin).
6. **SMTP:** set `vikunja.mail.enabled` in config for postfix-relay env vars, or configure in Vikunja settings. Vikunja `testmail` sends SMTP NOOP — some minimal relays may need manual SMTP config.
7. **Backup:** preserve `HDC_VIKUNJA_DB_PASSWORD` and the Docker volume (`vikunja-db-data`).

## Related

- [AGENTS.md — Vikunja](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/vikunja.config.schema.json`](../../../apps/hdc-cli/schema/vikunja.config.schema.json)
- Upstream docs: [Vikunja Docker walkthrough](https://vikunja.io/docs/docker-walkthrough/)
