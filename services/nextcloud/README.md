# Nextcloud All-in-One (`nextcloud`)

Nextcloud AIO mastercontainer on Proxmox LXC (privileged, Docker nesting). First-run setup stays in the AIO web wizard; hdc deploys the mastercontainer and maintain refreshes its image.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (in hdc-private for production)
- **Inventory:** [`inventory/manual/systems/nextcloud-a.json`](../../../inventory/manual/systems/nextcloud-a.json); [`inventory/manual/services/nextcloud.json`](../../../inventory/manual/services/nextcloud.json)
- **LXC:** privileged container with `nesting=1` and sufficient rootfs (64 GiB+ in example)
- **Reverse proxy (optional):** enable `nextcloud.aio.reverse_proxy` and follow [AIO reverse-proxy docs](https://github.com/nextcloud/all-in-one/blob/main/reverse-proxy.md) before exposing via nginx-waf

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision + Docker AIO mastercontainer Compose |
| `maintain` | Re-push `compose.yaml`; mastercontainer `docker compose pull` + `up -d`; ClamAV (`--skip-clamav`) |
| `query` | Config summary; `--live` for Docker/mastercontainer and HTTPS probe on interface port |
| `teardown` | Optional compose down then destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service nextcloud deploy -- --instance a
node apps/hdc-cli/cli.mjs run service nextcloud query -- --live
node apps/hdc-cli/cli.mjs run service nextcloud maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## Config

- `nextcloud.aio.interface_host_port` — default `8080` (AIO setup UI on the CT IP)
- `nextcloud.aio.reverse_proxy.enabled` / `domain` / `apache_port` — for nginx-waf or other reverse proxy
- `nextcloud.aio.image_channel` — `latest` or pinned AIO channel
- `install.compose_dir` — default `/opt/nextcloud-aio`

## After deploy

1. **AIO wizard:** open `https://<ct-ip>:8080` in a browser. Use the **CT IP address**, not a domain, per AIO HSTS guidance on first setup.
2. Complete domain, admin account, and optional apps in the AIO UI. Stack updates after first setup are managed in AIO; hdc `maintain` refreshes the mastercontainer only.
3. **Public HTTPS:** enable `nextcloud.aio.reverse_proxy` in config, configure nginx-waf per AIO reverse-proxy documentation, then run `maintain`.
4. **Inventory:** set `access.nodes[0].ip` on `nextcloud-a.json` from query output.

## Related

- [AGENTS.md — Nextcloud](../../../AGENTS.md)
- [nginx-waf README](../nginx-waf/README.md)
- [Nextcloud AIO reverse proxy](https://github.com/nextcloud/all-in-one/blob/main/reverse-proxy.md)
- Schema: [`apps/hdc-cli/schema/nextcloud.config.schema.json`](../../../apps/hdc-cli/schema/nextcloud.config.schema.json)
