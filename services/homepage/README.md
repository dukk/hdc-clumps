# Homepage (`homepage`)

Self-hosted [gethomepage.dev](https://gethomepage.dev/) dashboard on Proxmox LXC (Docker Compose). Service tiles and layout are defined in native YAML under `homepage/` and pushed to the container on deploy/maintain.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `homepage.allowed_hosts[]`, `homepage.public_url`, `homepage.config_files`, `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`
- **Dashboard YAML:** copy `homepage/*.example.yaml` → `homepage/*.yaml` in hdc-private (paths relative to package root)
- **Inventory:** `inventory/manual/systems/homepage-a.json`; `inventory/manual/services/homepage.json`
- **nginx-waf (optional):** internal HTTPS at `https://hdc.example.invalid` with `internal_only` access policy
- **DNS:** BIND A `homepage-a`; apex `@` → nginx-waf-a for HTTPS entry

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Homepage (`ghcr.io/gethomepage/homepage`) |
| `maintain` | Re-push YAML config + `.env`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe; `--lint` for services.yaml validation |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service homepage deploy -- --instance a
node apps/hdc-cli/cli.mjs run service homepage query -- --live
node apps/hdc-cli/cli.mjs run service homepage maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## Config

- `homepage.config_files` — paths relative to `clumps/services/homepage/` (`services`, `settings`, `bookmarks`, optional `widgets` YAML). hdc checks the public repo first, then hdc-private.
- `homepage.allowed_hosts[]` — required for `HOMEPAGE_ALLOWED_HOSTS` (comma-separated in container env)
- `homepage.public_url` — optional HTTPS URL shown in reports (e.g. `https://hdc.example.invalid`)

Edit `homepage/services.yaml` (and optional `settings.yaml` / `bookmarks.yaml` / `widgets.yaml`) in hdc-private and run `maintain` to refresh the dashboard. Use native gethomepage keys (`siteMonitor`, `disableIndexing`, etc.) — see [Homepage docs](https://gethomepage.dev/configs/services/). Header info bars (CPU, memory, disk, search, datetime) live in `widgets.yaml` — see [info widgets](https://gethomepage.dev/widgets/info/datetime/).

Trivy and WireGuard have no browser UI in this deployment; omit them from the dashboard or link only via `siteMonitor` if you add a health endpoint.

Non-HTTP services (BIND, databases, mail relays, etc.) do not answer HTTP — `siteMonitor` will always show a red dot. Use `ping` with the service IP for the Homepage status indicator (ICMP host reachability) when ICMP works from the Homepage container. Services with no web UI (step-ca) or HTTPS to a bare IP with a hostname certificate (step-ca, Wazuh, Greenbone) also fail `siteMonitor` from the Homepage container unless `NODE_TLS_REJECT_UNAUTHORIZED=0` is set (see Proxmox widget below); use `ping` there when ICMP is allowed, or `siteMonitor` with TLS bypass for LAN HTTPS checks.

**Proxmox tiles:** Prefer `siteMonitor: https://<node-ip>:8006` over `ping` when ICMP is blocked from the Homepage CT (common with nested Docker-on-LXC). hdc sets `NODE_TLS_REJECT_UNAUTHORIZED=0` automatically when `proxmox_widget` is enabled (opt out with `tls_insecure: false`). The custom Dockerfile layer adds `iputils` so `ping` works when ICMP routing allows it.

## Custom icons

Most tiles use [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) names (kebab-case, optional `.png` suffix). Examples: `draw-io.png`, `isc-bind9.png`, `immich.png`.

Services without a dashboard-icons entry can use vendored PNGs under `homepage/icons/` (public hdc repo). Reference them in `services.yaml` as `/icons/<name>.png`. hdc syncs that directory to the guest on deploy/maintain and mounts it at `/app/public/icons` in the Homepage container.

Run `homepage maintain` after adding or changing icons. See `homepage/icons/README.md` for upstream sources.

## Proxmox widget

Read-only hypervisor metrics use a dedicated Proxmox service account (not the hdc operator token). The account needs **PVEAuditor** on `/` for both the **user** and the **API token** (privilege separation enabled); hdc `proxmox maintain` ensures both.

1. Add `provision.service_accounts[]` with `id: homepage` in [`clumps/infrastructure/proxmox/config.json`](../../infrastructure/proxmox/config.example.json) (see proxmox README).
2. Enable `homepage.proxmox_widget` in homepage config (`service_account_id`, `hosts[]`).
3. Add `widget:` blocks to `homepage/services.yaml` using `{{HOMEPAGE_VAR_PROXMOX_*}}` placeholders.
4. Run `proxmox maintain` (or `homepage maintain`, which ensures the account first), then `homepage maintain` to push `.env` into the CT.

The Homepage stack builds a local image from [`docker/Dockerfile`](docker/Dockerfile) (upstream gethomepage + `iputils` for ICMP ping). When `proxmox_widget` is enabled, maintain injects `NODE_TLS_REJECT_UNAUTHORIZED=0` into the container `.env` so widget and `siteMonitor` HTTPS checks succeed against self-signed PVE certs (disable with `proxmox_widget.tls_insecure: false`).

Vault: `HDC_HOMEPAGE_PROXMOX_API_TOKEN`, `HDC_PROXMOX_USER_HOMEPAGE_PASSWORD` (auto-generated).

Put Proxmox tiles in a dedicated **Virtualization** group in `services.yaml` (not mixed into Infrastructure). Use a **cluster overview** tile without `node` for aggregate VM/LXC counts and CPU/memory; add per-node tiles with `node: pve-*` for single-node metrics. Set `showStats: true` on tiles (or globally in `settings.yaml`) so widget stats are expanded by default. Example layout in `settings.yaml`:

```yaml
showStats: true
layout:
  Virtualization:
    style: row
    columns: 3
    icon: proxmox.png
```

See `homepage/services.example.yaml` for the cluster + node widget pattern.

## Pi-hole widget

DNS query stats for Pi-hole instances use the admin password from [`clumps/services/pi-hole/config.json`](../pi-hole/config.example.json) `defaults.pihole.webpassword` (injected at maintain time, not stored in `services.yaml`).

1. Enable `homepage.pihole_widget` in homepage config (`version`, optional `instances[]`).
2. Add `widget:` blocks to `homepage/services.yaml` using `{{HOMEPAGE_VAR_PIHOLE_*}}` placeholders.
3. Run `homepage maintain` to push `.env` into the CT.

Widget `url` must be the Pi-hole base URL (LAN IP, no `/admin`). Set `version: 6` when running Pi-hole v6+.

## Service widgets (Immich, Glances, Home Assistant, …)

Additional gethomepage service widgets resolve credentials at maintain time and inject `HOMEPAGE_VAR_*` into the container `.env` (never store secrets in `services.yaml`).

| Config block | Tile | Vault / config |
| --- | --- | --- |
| `immich_widget` | Immich | `HDC_IMMICH_API_KEY` (`server.statistics`) |
| `glances_widget` | Glances | URL from glances package config |
| `homeassistant_widget` | Home Assistant | `HDC_HOMEPAGE_HA_TOKEN` (long-lived token) |
| `plex_widget` | Plex | `HDC_HOMEPAGE_PLEX_TOKEN`; optional `url` |
| `audiobookshelf_widget` | Audiobookshelf | `HDC_HOMEPAGE_AUDIOBOOKSHELF_TOKEN` |
| `uptime_kuma_widget` | Uptime Kuma, Uptime Kuma (Public Edge) | `slug` (default status page); optional `instances[]` and `slugs{}` per deployment (e.g. LAN `a` + OCI `ext-a`) |
| `crowdsec_widget` | CrowdSec | `HDC_HOMEPAGE_CROWDSEC_LAPI_PASSWORD`; optional `machine_id` |
| `unifi_widget` | UniFi | `HDC_UNIFI_NETWORK_API_KEY` (shared with unifi-network); URL/site from unifi-network config |
| `diskstation_widget` | NAS-1 DSM, NAS-2 DSM | `HDC_HOMEPAGE_SYNOLOGY_NAS_A_PASSWORD`, `HDC_HOMEPAGE_SYNOLOGY_NAS_B_PASSWORD`; DSM HTTP :5000; dedicated `homepage-stats` admin user (no 2FA) |
| `mailcow_widget` | Mailcow | `HDC_MAILCOW_API_KEY` (shared with mailcow package); URL from `mailcow.api_url` |
| `bind_widget` | BIND A, BIND B | Zone counts from bind config via `customapi` + maintain-pushed `stats/bind-*.json` (no secrets) |

1. Enable the `*_widget` block in homepage `config.json`.
2. Add matching `widget:` blocks in `homepage/services.yaml` with `{{HOMEPAGE_VAR_*}}` placeholders.
3. Set vault secrets / `uptime_kuma_widget.slug` (and optional `instances` / `slugs` for multiple Uptime Kuma deployments) as needed.
4. Run `node apps/hdc-cli/cli.mjs run service homepage query -- --lint`, then `maintain`.

Catalog and resolvers: [`lib/homepage-widget-catalog.mjs`](lib/homepage-widget-catalog.mjs), [`lib/homepage-widget-env.mjs`](lib/homepage-widget-env.mjs).

## Dashboard lint

`homepage maintain` runs [`homepage-services-lint.mjs`](lib/homepage-services-lint.mjs) before pushing config. Check locally with:

```bash
node apps/hdc-cli/cli.mjs run service homepage query -- --lint
```

Rules: every tile needs `icon`; vendored `/icons/*.png` must exist under `homepage/icons/`; enabled widgets must match YAML placeholders. See [`.cursor/rules/hdc-homepage-dashboard.mdc`](../../../.cursor/rules/hdc-homepage-dashboard.mdc).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.49:3000`).
2. **Inventory:** set `access.nodes[0].ip` on `homepage-a.json`.
3. **BIND:** A `homepage-a`; A `@` → nginx-waf-a for apex HTTPS.
4. **nginx-waf:** site `hdc-homepage` upstream to CT IP; `internal_only` on `/`; `websocket: true`.
5. **Browse:** `http://192.0.2.49:3000` or `https://hdc.example.invalid` from LAN.

## Related

- Schema: [`apps/hdc-cli/schema/homepage.config.schema.json`](../../../apps/hdc-cli/schema/homepage.config.schema.json)
- [Homepage docs](https://gethomepage.dev/installation/)
