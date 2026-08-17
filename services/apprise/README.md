# Apprise (`apprise`)

[Apprise API](https://github.com/caronc/apprise-api) — REST gateway for 130+ notification services on Proxmox LXC (Docker Compose, `caronc/apprise`). Default listen: `http://<ct-ip>:8000`. Health: `GET /status`.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, static `ip_config`, optional `apprise.public_url` for nginx-waf
- **Inventory:** `operations/inventory/systems/virtual/apprise-a.json`; `operations/inventory/services/apprise.json`
- **Vault:** none required. Optional `HDC_APPRISE_SECRET_KEY` (Django salt)
- **Mail:** `apprise.mail.enabled` (default true) builds a no-auth `mailto://` URL from postfix-relay `client_defaults` and seeds stateful key `ha` on deploy/maintain

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Apprise API (`caronc/apprise`); seed stateful keys |
| `maintain` | Re-push compose; `docker compose pull` + `up -d`; re-seed keys; guest Linux baseline |
| `query` | Config summary; `--live` for `/status` on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
hdc run service apprise deploy -- --instance a
hdc run service apprise query -- --live
hdc run service apprise maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-keys` (deploy/maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

`proxmox.lxc.vmid` of `0` allocates the next free cluster VMID on deploy and writes it back to `config.json`.

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (port 8000).
2. **Inventory:** set `access.nodes[0].ip` on `apprise-a.json`.
3. **Keys:** `POST /notify/ha` uses the seeded mailto URL (postfix-relay). Add Discord/etc. in the UI.
4. **HTTPS:** set `apprise.public_url`, BIND CNAME + nginx-waf `internal-lan` site.
5. **Home Assistant:** `notify` platform `apprise` with `config: http://apprise-a.hdc.dukk.org:8000/get/ha` (hdc `homeassistant maintain` when `homeassistant.apprise.enabled`).

## Related

- Schema: [`apps/hdc-cli/schema/apprise.config.schema.json`](../../../apps/hdc-cli/schema/apprise.config.schema.json)
- Upstream: [caronc/apprise-api](https://github.com/caronc/apprise-api)
