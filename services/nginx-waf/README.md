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
hdc run service nginx-waf maintain --
hdc run service nginx-waf query --
hdc run service nginx-waf maintain -- --group edge
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

## ACME challenge forwarding (HTTP-01, multi-node)

Certbot runs only on the group's `cert-primary`; certificates reach the `peer` via the cert-sync hook. (Legacy — with `acme.cert_ha.enabled` see **Certificate HA** below.)
Cloudflare load-balances between both WAF origins, so Let's Encrypt (multi-perspective validation) can hit the peer.
On HTTP-01 groups, `maintain` therefore renders every port-80 server block on **peer** nodes (each site and the
default catch-all) with:

```nginx
location ^~ /.well-known/acme-challenge/ {
    proxy_pass http://<cert-primary-ip>;   # proxmox.qemu.ip of the cert-primary, else configure.ssh.host
    proxy_set_header Host $host;
    ...
}
```

The cert-primary keeps serving its certbot webroot (`acme.webroot`), including on the default catch-all, so
challenges for hosts without a vhost yet also validate. Nothing to configure: the primary IP comes from
`deployments[]`. The forwarding is applied by `maintain` (site push); re-run maintain after `deploy`.

On HTTP-01 groups maintain also pushes the peer (with forwarding) right before certbot runs. To verify forwarding without spending Let's Encrypt attempts, push sites only: `hdc run service nginx-waf maintain -- --group public --site <id> --skip-certs`, drop a test file in the primary's webroot and fetch it through each node.

## Certificate HA (`acme.cert_ha`, any node can renew)

With `deployment_groups[].acme.cert_ha.enabled: true` the single cert-primary model above is replaced:
every WAF node in the group gets the same tooling from hdc (`maintain`/`deploy` install it — nothing is
hand-made on the hosts), so a rebuilt node or a new `waf-c`/`waf-d` only needs a `deployments[]` entry
and a place in `cert_ha.priority`.

Installed on each node by `lib/cert-ha.mjs`:

| Path | What |
|------|------|
| `/usr/local/sbin/hdc-nginx-waf-certs` | on-host tool (`assets/hdc-nginx-waf-certs.py`): `renew`, `check`, `push`, `status`, `deploy-hook`, `serve` |
| `/etc/hdc/nginx-waf-certs.json` | self id, ordered peer list (`priority` 0 = leader), thresholds, alert recipients |
| `/etc/hdc/nginx-waf-certs/id_ed25519` | shared node-to-node key (vault `cert_ha.peer_ssh_key_vault_key`, default `HDC_NGINX_WAF_CERT_PEER_SSH_KEY`) |
| `~hdc/.ssh/authorized_keys` | one managed line for that key: forced `command=… serve`, `from=` peer IPs, no pty/forwarding (other keys untouched) |
| `/etc/sudoers.d/hdc-nginx-waf-certs` | `hdc` may run only `hdc-nginx-waf-certs serve-root *` as root |
| `/usr/local/share/ca-certificates/*.crt` | `cert_ha.trust_root_ca_files` (e.g. step-ca root) → system trust, so `certbot renew` works for step-ca lineages |
| `/etc/letsencrypt/hdc-dns-rfc2136.ini` | TSIG credentials for DNS-01 (from vault `acme.dns.tsig_vault_key`) on **every** node |
| `hdc-nginx-waf-cert-renew.timer` | twice daily, staggered by priority (leader first); `certbot.timer` is disabled + masked |
| `hdc-nginx-waf-cert-check.timer` | daily compare / sync / alert |
| `/etc/letsencrypt/renewal-hooks/deploy/hdc-nginx-waf-certs` | after each issuance: `nginx -t` + reload, push the lineage to peers |

**Leader + lock.** The node with priority 0 always runs `certbot renew`. A lower-priority node renews only if
every higher-priority node is unreachable, has not finished a renew run within `takeover_after_hours` (36h),
or the fleet holds a renewable cert within `takeover_days` (21d) of expiry. Before running certbot a node takes
a lease (`/var/lib/hdc-nginx-waf-certs/renew.lease`, 3h TTL) on itself and on every reachable peer, in priority
order; if any peer already holds it, everything is released and the run is skipped — two nodes never renew at once.

**Sync.** `check`/`push` compare SHA-256 fingerprint + notAfter per lineage with each peer; the newest *valid*
copy (cert/key match, not expired) wins in either direction (ties → higher priority). Transfers are per lineage
(`live/`, `archive/`, `renewal/X.conf`; ACME accounts are added, never overwritten); the receiver validates,
backs up, swaps, runs `nginx -t` and restores on failure before reloading.

**Alerts** (journal tag `hdc-nginx-waf-certs` + mail via the host's postfix relay to `cert_ha.alert.mail_to`,
optional `uptime_kuma_push_url`) fire only when the problem set changes: peer mismatch left after sync, cert
within `warn_days` (14d), renewal failure, no node renewed within 36h, unreachable peer — and once more when all clear.
Fleet-wide problems are mailed by the highest-priority reachable node only.

**HTTP-01 with no single node.** Instead of proxying challenges to the cert-primary, every node serves its own
webroot and falls back to its peers (`try_files $uri @hdc_acme_peers`, one hop, `proxy_next_upstream http_404`),
on :80, :443 and the default catch-all; the peer upstream lives in `/etc/nginx/hdc/acme-peers.conf`.

Useful commands:

```bash
sudo hdc-nginx-waf-certs status                       # this node
sudo hdc-nginx-waf-certs check                        # compare/sync now (prints actions + problems)
sudo hdc-nginx-waf-certs renew --dry-run --simulate-down vm-nginx-waf-a   # leader-down test on waf-b (staging)
hdc run service nginx-waf maintain -- --group public --instance b --skip-certs   # roll out to one node
hdc run service nginx-waf maintain -- --group public --sync-certs                # push --all from every node
```

`--instance` / `--system-id` limit every maintain step to that node, and certificate obtain runs on the
highest-priority selected node — so `maintain -- --instance b` issues from waf-b while waf-a is down.
Names outside the BIND zone(s) (Cloudflare-hosted) still need HTTP-01; LAN-only names belong on a separate
`challenge: dns-01` site (see `docuseal-hdc`).
