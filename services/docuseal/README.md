# DocuSeal (`docuseal`)

Self-hosted document signing on Proxmox LXC (Docker Compose + PostgreSQL). Public HTTPS access is typically via **nginx-waf** using `docuseal.public_url` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and `docuseal.public_url`
- **Inventory:** `inventory/manual/systems/docuseal-a.json`; `inventory/manual/services/docuseal.json`
- **Vault:** `HDC_DOCUSEAL_SECRET_KEY_BASE` and `HDC_DOCUSEAL_DB_PASSWORD` (auto-generated on first deploy if missing)
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:3000` with WebSockets enabled on `/`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker DocuSeal + PostgreSQL |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for HTTP probe |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service docuseal deploy -- --instance a
node apps/hdc-cli/cli.mjs run service docuseal query -- --live
node apps/hdc-cli/cli.mjs run service docuseal maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.x:3000`).
2. **Inventory:** set `access.nodes[0].ip` on `docuseal-a.json`.
3. **BIND / Cloudflare:** A record for the hostname in `docuseal.public_url` (e.g. `sign.example.invalid`).
4. **nginx-waf:** add a site with `proxy_pass` to the CT upstream; enable WebSockets; consider `proxy_read_timeout 300s` for slow PDF renders.
5. **First run:** complete admin setup in the DocuSeal web UI.
6. **SMTP:** `docuseal.mail.enabled` maps postfix-relay to `SMTP_*` env vars; admin UI settings may override env on some releases.
7. **Backup:** preserve `HDC_DOCUSEAL_DB_PASSWORD`, the Postgres Docker volume, and `./data` document storage — snapshot both together on restore.

## Related

- Schema: [`apps/hdc-cli/schema/docuseal.config.schema.json`](../../../apps/hdc-cli/schema/docuseal.config.schema.json)
- Upstream: [DocuSeal](https://github.com/docusealco/docuseal) · [Env vars](https://www.docuseal.com/docs/configuring-docuseal-via-environment-variables)
