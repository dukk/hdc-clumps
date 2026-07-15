# HDC service dependencies (deploy skill reference)

Use this when filling **section 7** of [plan-template.md](plan-template.md). Default: **none** unless the user opts in. Never apply dependency packages without explicit approval in the plan.

**Upstream rule:** After deploy or `query --live`, use the reported guest IP and port (e.g. deploy `upstream_url`, manifest `operation_report.next_steps`). Do not invent `http://` targets.

## Apply order (when multiple deps are approved)

1. **synology-nas** `maintain` — required before `synology-docker` service deploy (Container Manager, SSH).
2. **Service deploy** — the app package itself.
3. **bind** `maintain` — internal authoritative A record (forward zone in bind config).
4. **nginx-waf** or **nginx** `maintain` — reverse proxy site to guest upstream (nginx-waf always syncs all vhosts from config).
5. **cloudflare** `maintain` — public DNS (often proxied A to WAF WAN IP).
6. **nagios** `maintain` — regenerates checks from BIND A records (after BIND is updated).

## Package actions

| Package | Tier | Typical verb | What it does |
|---------|------|--------------|--------------|
| `synology-nas` | infrastructure | `maintain` | SSH, Docker/Container Manager, DSM updates |
| `bind` | service | `maintain` | Push zone files; forward A records for hostnames |
| `nginx-waf` | service | `maintain` | Push full `sites[]` from config, LE certs, ModSecurity; `--site <id>` scopes certificate work only |
| `nginx-waf` | service | `query --live` | Health plus live vhost drift audit (`vhost_drift[]`) vs config |
| `nginx` | service | `maintain` | Push `sites[]` without WAF; `--site <id>` selective |
| `cloudflare` | infrastructure | `maintain` | Apply `zones[]` DNS; `--zone <name>` selective; `--prune` only when intended |
| `nagios` | service | `maintain` | Regenerate Nagios hosts from BIND forward A records |
| `proxmox` | infrastructure | `maintain` | Templates, storage — rarely part of app deploy; use for capacity checks |

Vault names (no values in plans): `HDC_BIND_TSIG_KEY` (DNS-01 for nginx/nginx-waf), `HDC_NGINX_WAF_LETS_ENCRYPT_EMAIL`, `HDC_NGINX_LE_EMAIL`, `HDC_CLOUDFLARE_API_TOKEN`.

## Service matrix (typical — confirm per README)

| Service | Default exposure | synology-nas | bind | nginx-waf / nginx | cloudflare | nagios |
|---------|------------------|:------------:|:----:|:-----------------:|:----------:|:------:|
| searxng | LAN HTTPS | — | yes | yes | — | after BIND |
| yacy | LAN HTTPS | — | yes | yes | — | after BIND |
| vaultwarden | HTTPS (`domain` in config) | — | yes | yes (`:80` upstream) | optional | after BIND |
| n8n | HTTPS (`public_url`) | — | yes | yes (`:5678`, WebSockets) | optional | after BIND |
| immich | HTTPS | yes (synology-docker mode) | yes | yes (`:2283`) | optional | after BIND |
| postiz | HTTPS | — | yes | yes | optional | after BIND |
| open-webui | LAN HTTPS (`internal-lan`) | — | yes | yes (`:3000`, WebSockets) | — | after BIND |
| nextcloud | HTTPS (AIO UI) | — | yes | yes | optional | after BIND |
| scanopy | LAN HTTPS | — | yes | yes | — | after BIND |
| uptime-kuma | LAN HTTPS | — | yes | yes (`:3001`, WebSockets) | — | after BIND |
| gatus | LAN | — | optional | optional | optional | after BIND |
| pi-hole | LAN DNS | — | — | — | — | after BIND |
| bind | infrastructure | — | — | — | — | — |
| nginx-waf | infrastructure | — | uses bind for DNS-01 | — | optional | after BIND |
| homeassistant | LAN / ha.example.invalid | — | often manual IP in HA UI; **trusted_proxies** on WAF IPs after nginx-waf | may exist | optional | after BIND |
| postgresql, redis, kafka, etc. | internal | — | optional | — | — | optional |

## Patterns by exposure

### LAN HTTPS via nginx-waf (`internal-lan`)

For LAN browser UIs and HTTP APIs on `*.home.example.invalid` that must **not** be reachable from the public internet:

1. Set `public_url` in service config (`https://<name>.home.example.invalid`).
2. Deploy service; note CT/VM IP and **listen port** from output.
3. **bind:** keep `*-a` A record on the guest IP for SSH/Nagios; add or flip short-name **CNAME** to `nginx-waf-a.home.example.invalid.` when the friendly hostname is not the `*-a` record.
4. **nginx-waf:** add `sites[]` with `listen: [80, 443]`, `upstream: http://<guest-ip>:<port>`, `host_names`, `tls`, `locations[].websocket: true` when needed, and `"policies": ["internal-lan", { "type": "modsecurity", "enabled": false }]`. Do **not** set `client_ip: cloudflare`.
5. **homepage / inventory:** update dashboard `href` and `web_ui` to the HTTPS hostname (no port); keep `siteMonitor` on direct guest IP for health checks.
6. Service **maintain** to re-push compose/env when `public_url` affects runtime config.
7. **nagios** `maintain` after BIND changes if host checks should follow updated records.

### LAN-only (no nginx-waf)

- Deploy + inventory IP update + `query --live` is enough when no friendly HTTPS hostname is needed.
- DNS (BIND port 53, Pi-hole), SMTP, MQTT, and non-HTTP protocols stay on guests — do not proxy through nginx-waf.

### Public HTTPS via nginx-waf

1. Set `public_url` / `domain` in service config (`https://…`).
2. Deploy service; note CT/VM IP and **listen port** from output.
3. **bind:** add forward A record (name → guest IP or WAF IP per your design).
4. **nginx-waf:** add `sites[]` entry with `proxy_pass` to `http://<guest-ip>:<port>`; `client_ip: cloudflare` when behind Cloudflare.
5. **cloudflare:** A record to WAF WAN IP (proxied) if used.
6. **nagios:** `run service nagios maintain --` after BIND has the A record.
7. **homeassistant only:** after nginx-waf site is live, configure HA `http.trusted_proxies` for `vm-nginx-waf-a` / `vm-nginx-waf-b` LAN IPs — see [homeassistant README](../../../services/homeassistant/README.md).

See [vaultwarden README](../../../services/vaultwarden/README.md) and [n8n README](../../../services/n8n/README.md) for step lists.

### Synology Docker (`synology-docker` mode)

- Run `hdc run infrastructure synology-nas maintain -- --instance a` (or `b`) **before** immich-style deploy.
- Compose path under `/volume1/docker/…` per service config.
- Public HTTPS still uses bind + nginx-waf upstream to NAS IP:port (e.g. immich `:2283`).

### configure-only (guest already exists)

- No Proxmox provision in service deploy; plan lists `configure.ssh` targets only.
- nginx / nginx-waf packages push vhosts to existing VMs.

## Selective maintain (do not over-touch)

- **nginx-waf / nginx:** `--site <id>` on nginx-waf scopes Let's Encrypt only; all vhosts are still pushed from config. Full maintain without `--site` may prune removed sites. Run `nginx-waf query -- --live` after proxy changes to catch vhost drift.
- **cloudflare:** `--zone <name>`; use `--prune` only when removal is intended.
- **unifi-network:** `--rule` filter — unrelated to most app deploys.
