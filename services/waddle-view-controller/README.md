# Waddle View controller (`waddle-view-controller`)

[waddle_controller](https://github.com/dukk/waddle-view/tree/main/apps/waddle_controller) — operator web UI + BFF for Waddle View displays, on Proxmox LXC via Docker Compose ([GHCR](https://github.com/dukk/waddle-view/packages)).

Default LAN access: `https://<ct-ip>:8443` (container nginx self-signed TLS). Health: `/bff/health`.

## Prerequisites

- **Image:** `ghcr.io/dukk/waddle-view-controller:<tag>` must be published (public pull assumed). Override `waddle_view_controller.image` / `image_tag` if the package name differs.
- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, positive `proxmox.lxc.vmid`, static `ip_config`, and optional `waddle_view_controller.public_url` for future nginx-waf
- **Inventory:** `operations/inventory/systems/virtual/waddle-view-controller-a.json`; `operations/inventory/services/waddle-view-controller.json` (create at deploy time)
- **Vault:** `HDC_WADDLE_VIEW_CONTROLLER_SESSION_SECRET` when `auth_enabled` is true (default)

```bash
hdc secrets set HDC_WADDLE_VIEW_CONTROLLER_SESSION_SECRET
```

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker controller (`ghcr.io/dukk/waddle-view-controller`) |
| `maintain` | Re-push `docker-compose.yml` + `.env`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTPS `/bff/health` probe on host port |
| `teardown` | Optional compose down, destroy LXC |

```bash
hdc run service waddle-view-controller deploy -- --instance a
hdc run service waddle-view-controller query -- --live
hdc run service waddle-view-controller maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP / URL:** from deploy/query `upstream_url` (e.g. `https://192.0.2.x:8443`). Accept the self-signed cert in the browser.
2. **Inventory:** set `access.nodes[0].ip` on `waddle-view-controller-a.json`.
3. **Auth:** with `auth_enabled: true`, enable **User mode** in Settings and create the first admin account in the UI.
4. **Data:** SQLite + backups persist under `/opt/waddle-view-controller/data` → `/var/lib/waddle-controller` in the container.
5. **HTTPS edge (optional):** set `waddle_view_controller.public_url`, add BIND + nginx-waf upstream when terminating real TLS instead of the container cert.

## Deferred until image publish

Live Proxmox node, static IP, and inventory sidecars are intentionally not assigned in the scaffolded `config.json`. After GHCR publish:

1. Confirm image name/tag in config
2. Set vault session secret
3. Write `plan.md` with real `host_id` + IP from `ip-allocations.md`
4. `hdc run service waddle-view-controller deploy -- --instance a`

## Related

- Upstream: [dukk/waddle-view](https://github.com/dukk/waddle-view)
- Schema (sibling hdc): `apps/hdc-cli/schema/waddle-view-controller.config.schema.json`
