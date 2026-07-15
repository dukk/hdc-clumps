# Vaultwarden (`vaultwarden`)

Bitwarden-compatible password manager on Proxmox LXC (Docker Compose). Public HTTPS access is via **nginx-waf** using `vaultwarden.domain` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `vaultwarden.domain` (`https://…`), `proxmox.host_id`, `proxmox.lxc.vmid`
- **Inventory:** [`inventory/manual/systems/vaultwarden-a.json`](../../../inventory/manual/systems/vaultwarden-a.json); [`inventory/manual/services/vaultwarden.json`](../../../inventory/manual/services/vaultwarden.json)
- **Vault:** `HDC_VAULTWARDEN_ADMIN_TOKEN` (required) — store the **plain** admin password; deploy/maintain hash it to Argon2 PHC for `ADMIN_TOKEN` in `.env`
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:80` after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Vaultwarden |
| `maintain` | Re-push `.env`; `docker compose pull` + `up -d`; ClamAV |
| `query` | Config summary; `--live` for `/alive` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_VAULTWARDEN_ADMIN_TOKEN
node apps/hdc-cli/cli.mjs run vaultwarden deploy -- --instance a
node apps/hdc-cli/cli.mjs run vaultwarden query -- --live
node apps/hdc-cli/cli.mjs run vaultwarden maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.123:80`).
2. **Inventory:** set `access.nodes[0].ip` on `vaultwarden-a.json`.
3. **BIND:** forward A record for the hostname in `vaultwarden.domain`.
4. **nginx-waf:** add a site with upstream to the CT IP; set `"websocket": true` on locations that need WebSockets (e.g. `/` and `/notifications/hub` for Vaultwarden). On the `/admin` location, set `"waf": { "enabled": false }` so OWASP CRS does not block admin Save POSTs (see [nginx-waf README](../nginx-waf/README.md)).
5. **Admin:** open `{domain}/admin` only (must match `vaultwarden.domain`; LAN only via nginx-waf) and sign in with the plain password from `HDC_VAULTWARDEN_ADMIN_TOKEN` (not the Argon2 hash in the container `.env`).
6. **hdc secrets:** set `HDC_VAULTWARDEN_URL`, `HDC_VAULTWARDEN_EMAIL` in `.env`; install [Bitwarden CLI](../../../docs/manually-deployed/bitwarden-cli.md); create your Vaultwarden user account.
7. **Nagios:** `node apps/hdc-cli/cli.mjs run service nagios maintain --` after BIND A record exists.

## Related

- [Bitwarden CLI for hdc secrets](../../../docs/manually-deployed/bitwarden-cli.md)

- [AGENTS.md — Vaultwarden](../../../AGENTS.md)
- [nginx-waf README](../nginx-waf/README.md)
- Schema: [`apps/hdc-cli/schema/vaultwarden.config.schema.json`](../../../apps/hdc-cli/schema/vaultwarden.config.schema.json)
