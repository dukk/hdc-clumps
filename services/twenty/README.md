# Twenty CRM (`twenty`)

Open-source CRM ([twentyhq/twenty](https://github.com/twentyhq/twenty)) on Proxmox LXC or QEMU Ubuntu via Docker Compose (server + worker + PostgreSQL + Redis). Public HTTPS is typically via **nginx-waf** using `twenty.public_url`; omit `public_url` for LAN-only access on the guest IP.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid` or `proxmox.qemu.*`, optional static IP, and `twenty.public_url` when using nginx-waf
- **Inventory:** `inventory/manual/systems/twenty-a.json` or `vm-twenty-a.json`; `inventory/manual/services/twenty.json`
- **Vault:** `HDC_TWENTY_ENCRYPTION_KEY` and `HDC_TWENTY_DB_PASSWORD` (auto-generated on first **deploy** only; **maintain** fails if either is missing)
- **nginx-waf:** reverse-proxy site pointing at `http://<guest-ip>:3000` when using a public hostname

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC or QEMU + Docker Twenty stack |
| `maintain` | Re-push compose + `.env`; staged `docker compose up`; guest baseline |
| `query` | Config summary; `--live` for `/healthz` and guest power state on failure |
| `teardown` | Optional compose down, destroy guest |

```bash
node apps/hdc-cli/cli.mjs run service twenty deploy -- --instance a
node apps/hdc-cli/cli.mjs run service twenty query -- --live
node apps/hdc-cli/cli.mjs run service twenty maintain --
```

## Resilience (outage prevention)

- **Guest power:** `maintain` auto-starts a stopped Proxmox LXC or QEMU guest and waits for SSH before touching the stack. `deploy --skip-existing` still ensures the guest is powered on (provision/install are skipped, not power management).
- **Postgres password:** When the `db-data` volume is already initialized, maintain reconciles the Postgres role password from vault (`.env`) with `ALTER USER` and verifies login — no volume wipe required.
- **Staged startup:** Maintain and install bring up db/redis, sync Postgres when needed, start server with a `/healthz` poll, then start worker. Compose uses `service_started` (not `service_healthy`) for worker → server so a raw `docker compose up -d` is less likely to abort during long migrations.
- **ENCRYPTION_KEY / JWT signing:** Never change `HDC_TWENTY_ENCRYPTION_KEY` without a rotation plan. Maintain stores an encryption-key fingerprint at `{compose_dir}/.hdc/encryption-key-id`. If the fingerprint changes and `FALLBACK_ENCRYPTION_KEY` is not set, maintain purges stale `core.signingKey` rows so Twenty mints fresh JWT keys (users may need to sign in again; CRM data is preserved). A log-based safety net restarts server/worker when JWT signing errors are detected. For intentional rotation, set vault `HDC_TWENTY_ENCRYPTION_KEY_FALLBACK` (previous key), push via maintain, then run Twenty `yarn command:prod secret-encryption:rotate` inside the server container before removing the fallback.

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. Wait 1–2 minutes for DB migrations; confirm `GET /healthz` returns OK.
2. **First-run signup:** open `SERVER_URL` in a browser and create the first account (becomes admin when `multi_workspace_enabled` is false).
3. **Guest IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.x:3000`).
4. **Inventory:** set `access.nodes[0].ip` on the system sidecar.
5. **HTTPS:** set `twenty.public_url` before first login when using nginx-waf; add BIND A record and nginx-waf upstream.
6. **LAN-only:** omit `public_url`; browse `http://<guest-ip>:3000`.
7. **Backup:** preserve vault keys and Docker volumes (`db-data`, `server-local-data`); Postgres database name is **`default`**.

## Related

- Schema: [`apps/hdc-cli/schema/twenty.config.schema.json`](../../../apps/hdc-cli/schema/twenty.config.schema.json)
- Upstream: [Twenty Docker Compose docs](https://docs.twenty.com/developers/self-host/capabilities/docker-compose)
