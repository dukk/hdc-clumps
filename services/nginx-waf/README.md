# Nginx WAF (`nginx-waf`)

Nginx with ModSecurity (OWASP CRS), reverse proxy `sites[]`, catalog-driven security **policies**, ACME certificates (Let's Encrypt or custom step-ca), optional cert sync between HA nodes, and deployment groups for separate WAF pairs.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (`schema_version`: **4**)
- **Inventory:** [`inventory/manual/systems/vm-nginx-waf-a.json`](../../../inventory/manual/systems/vm-nginx-waf-a.json), [`vm-nginx-waf-b.json`](../../../inventory/manual/systems/vm-nginx-waf-b.json); [`inventory/manual/services/nginx-waf.json`](../../../inventory/manual/services/nginx-waf.json)
- **Vault:** `HDC_NGINX_WAF_LETS_ENCRYPT_EMAIL` (required for Let's Encrypt); legacy `HDC_NGINX_WAF_LE_EMAIL` is still read with a deprecation warning. Default ACME challenge is **http-01** (webroot). Optional group `acme.dns` enables **dns-01** fallback via BIND RFC2136 when HTTP obtain fails — only for hostnames in that authoritative zone (e.g. `*.home.example.invalid`). Public names on **Cloudflare DNS** (`*.example.invalid` via orange-cloud, `brand-a.example`, `brand-b.example`, etc.) must use http-01 through Cloudflare proxy to the WAF; BIND fallback is skipped when SANs are outside `acme.dns.zone` (`HDC_BIND_TSIG_KEY` required for DNS fallback).

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU (optional) + nginx + ModSecurity + CRS; push sites; ACME on cert-primary per group |
| `maintain` | Grow root disk when `defaults.proxmox.qemu.rootfs_gb` exceeds live size (`--skip-disk-resize`); re-push CRS and group sites; `--renew-certs`; `--sync-certs`; `--site <id>` (certificate scope only); `--group <id>` |
| `query` | nginx, ModSecurity profiles, CRS rule count, policy summary per site, certs, upstream probes; `--live` adds vhost drift audit vs config |

```bash
node apps/hdc-cli/cli.mjs run service nginx-waf maintain --
node apps/hdc-cli/cli.mjs run service nginx-waf query --
node apps/hdc-cli/cli.mjs run service nginx-waf maintain -- --group edge
```

## Config layout (schema v4)

Top-level **`deployment_groups[]`** each contain:

- `id` — slug (`edge`, `internal`, …)
- `acme` — group ACME defaults (`provider`: `lets_encrypt` or `custom` + `server` URL for step-ca)
- `sites[]` — vhosts pushed only to that group's nodes
- `deployments[]` — exactly one `cert-primary` and optional `peer` per group
- `default_site.enabled` — catch-all 404 page for unmatched hostnames (default **true**)
- optional `policy_definitions` — merge over `defaults.nginx_waf.policy_definitions`

**v3 migration:** `site.waf` and `location.access.internal_only` are auto-converted to `policies[]` at normalize time (stderr deprecation warnings). Set `schema_version: 4` and prefer explicit `policies[]` in config.

## Policy catalog

Define reusable policies under **`defaults.nginx_waf.policy_definitions`** (and optional per-group overrides). Sites and locations attach policies by **name** or inline `{ "type": "…" }` object.

Auto-seeded catalog entries (from legacy `modsecurity` / `trusted_cidrs` defaults):

| Id | Type | Purpose |
|----|------|---------|
| `modsecurity-default` | `modsecurity` | OWASP CRS via `/etc/modsecurity/hdc-waf-modsecurity-default.conf` |
| `internal-lan` | `trusted_cidrs` | RFC1918-style ranges from `defaults.nginx_waf.trusted_cidrs` |
| `block-exploits` | `block_common_exploits` | Shared http-level path regex map |
| `hide-version` | `server_tokens` | `server_tokens off` |

Example site:

```json
"policies": ["modsecurity-default", "cloudflare-only", "hide-version", "block-exploits"],
"locations": [
  { "path": "/admin", "policies": ["internal-lan", { "type": "modsecurity", "enabled": false }] }
]
```

**Policy types:** `modsecurity`, `trusted_cidrs`, `cloudflare_origin`, `server_tokens`, `rate_limit`, `client_buffers`, `http_protocol`, `block_common_exploits`. Location policies override site policies for the same `type`.

## Sites

Each site requires `id`, **`host_names`**, and `upstream` (string URL or upstream pool object).

**HTTPS defaults:** TLS enabled; HTTP redirects to HTTPS unless `tls.http_redirect: false`. Set `tls.enabled: false` for HTTP-only sites.

**ACME per site:** override group defaults with `tls.certificate`:

```json
"certificate": {
  "provider": "custom",
  "server": "https://ca.home.example.invalid/acme/acme/directory"
}
```

Install the step-ca root at `acme.root_ca_path` on WAF nodes (default `/etc/ssl/certs/hdc-step-ca-root.crt`) before using custom ACME.

**Cloudflare DNS zones:** Group `acme.dns` targets authoritative BIND (RFC2136 to `acme.dns.zone`, typically `hdc.example.invalid`). Public hostnames on Cloudflare — including `*.example.invalid` CNAMEs to `waf.example.invalid`, `brand-a.example`, and `brand-b.example` — obtain certs via **http-01** only (orange-cloud proxy to WAF port 80). dns-01 fallback is skipped when any cert SAN is outside `acme.dns.zone`.

**Upstream pools:**

```json
"upstream": {
  "method": "least_conn",
  "servers": [
    { "url": "https://pve-a.home.example.invalid:8006", "weight": 1 },
    { "url": "https://pve-b.home.example.invalid:8006", "weight": 1 }
  ]
}
```

Optional **`locations[].upstream`** overrides the site default for that path.

## Default 404 site

When `default_site.enabled` is true, hdc installs `hdc-default.conf` as nginx `default_server` (ASCII duck 404 page at `/var/www/hdc-default/index.html`) and removes the Debian default site.

## Network access (`trusted_cidrs` policy)

Restrict URL paths to trusted networks using the **`internal-lan`** catalog entry or a custom `trusted_cidrs` policy. Clients outside allowed CIDRs receive `401` or `404` per `deny_status`.

**Global defaults** (`defaults.nginx_waf.trusted_cidrs`): RFC1918-style ranges. Override in `config.json` or define named groups in a `trusted_cidrs` policy definition.

**Per-site** (optional):

- `client_ip`: `remote_addr` (default) or `cloudflare` (sets `real_ip` from `CF-Connecting-IP`)
- **`cloudflare-only`** policy: reject direct-origin requests missing Cloudflare headers

## Upstream proxy headers

When `proxy_headers` is true (default), hdc sets `X-HDC-Nginx-Waf-Node`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`.

## WebSockets

Set `"websocket": true` on locations that need Upgrade proxying. The global `map $http_upgrade $connection_upgrade` lives in `/etc/nginx/hdc/waf-maps.conf` (included from `waf-global.conf`).

## Migrating from v3

1. Set `schema_version: 4`
2. Add `defaults.nginx_waf.policy_definitions` for custom policies (e.g. `cloudflare-only`)
3. Replace `waf: { enabled: true }` with `"policies": ["modsecurity-default", "hide-version", "block-exploits"]`
4. Replace `locations[].access.internal_only` with `"policies": ["internal-lan"]`
5. Cloudflare-fronted sites: add `"cloudflare-only"` to site `policies[]`
6. Run `maintain` to push updated vhosts, maps, and ModSecurity profile files

Legacy `waf` / `access` fields still work for one release via normalize-time migration.

## Common flags

`--group <id>`, `--instance a|b`, `--destroy-existing`, `--skip-provision`, `--renew-certs`, `--sync-certs`, `--site <id>`, `--skip-disk-resize`, `--dry-run`.

## Related

- [AGENTS.md — Nginx WAF](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/nginx-waf.config.schema.json`](../../../apps/hdc-cli/schema/nginx-waf.config.schema.json)
