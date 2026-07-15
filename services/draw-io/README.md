# draw.io (`draw-io`)

Self-hosted [diagrams.net / draw.io](https://github.com/jgraph/docker-drawio) on Proxmox LXC (Docker Compose). Public HTTPS access is via **nginx-waf** using `draw_io.public_url` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `draw_io.public_url` (`https://…`), `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`
- **Inventory:** `inventory/manual/systems/draw-io-a.json`; `inventory/manual/services/draw-io.json`
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:8080` after deploy
- **DNS:** Cloudflare CNAME `draw` → `waf.example.invalid`; BIND A `draw-io-a` + CNAME `draw` → WAF

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker draw.io (`jgraph/drawio`) |
| `maintain` | Re-push `.env`; `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service draw-io deploy -- --instance a
node apps/hdc-cli/cli.mjs run service draw-io query -- --live
node apps/hdc-cli/cli.mjs run service draw-io maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.155:8080`).
2. **Inventory:** set `access.nodes[0].ip` on `draw-io-a.json`.
3. **nginx-waf:** add site with upstream to the CT IP; `client_ip: cloudflare`; `websocket: true` on `/`.
4. **Cloudflare:** CNAME `draw` → `waf.example.invalid` (proxied).
5. **BIND:** A `draw-io-a`; CNAME `draw` → `nginx-waf-a.home.example.invalid.`
6. **Browse:** `https://draw.example.invalid`

## Related

- Schema: [`apps/hdc-cli/schema/draw-io.config.schema.json`](../../../apps/hdc-cli/schema/draw-io.config.schema.json)
- [nginx-waf README](../nginx-waf/README.md)
