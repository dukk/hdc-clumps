# RustDesk (`rustdesk`)

Self-hosted **RustDesk Server OSS** (`hbbs` ID/signaling + `hbbr` relay) on a privileged Proxmox LXC with Docker Compose and host networking.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` in hdc-private (`clumps/services/rustdesk/config.json`)
- **Inventory:** [`inventory/manual/systems/rustdesk-a.json`](../../../inventory/manual/systems/rustdesk-a.json), [`inventory/manual/services/rustdesk.json`](../../../inventory/manual/services/rustdesk.json)
- **Static IP** on the LXC (`proxmox.lxc.ip_config`) — clients need a stable ID server address
- **Privileged LXC** (`unprivileged: 0`) with Docker nesting features (see example config)
- **No vault secrets** for v1 — the server public key is generated in `/opt/rustdesk/data/id_ed25519.pub`

## Ports (LAN)

| Protocol | Port | Service |
|----------|------|---------|
| TCP | 21115 | hbbs NAT type test |
| TCP + UDP | 21116 | hbbs ID / registration |
| TCP | 21117 | hbbr relay |
| TCP | 21118 | hbbs WebSocket (web client) |
| TCP | 21119 | hbbr WebSocket (web client) |

Ensure LAN firewalls allow these ports when clients are on other subnets. WAN/UniFi port forwarding is **not** automated by this package (v1 is LAN-only).

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision + Docker Compose hbbs/hbbr (`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`) |
| `maintain` | Re-push compose, `docker compose pull` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for docker status, public key, client config hints |
| `teardown` | Optional compose down then destroy LXC (`--dry-run`, `--yes`, `--skip-compose-down`) |

```bash
node apps/hdc-cli/cli.mjs run service rustdesk deploy -- --instance a
node apps/hdc-cli/cli.mjs run service rustdesk query -- --live
node apps/hdc-cli/cli.mjs run service rustdesk maintain --
```

## Client configuration (after deploy)

1. Run `query --live` and note `id_server` and `public_key`.
2. On each RustDesk client: **Settings → Network → ID/Relay server**
   - **ID server:** `id_server` value (CT static IP, or `rustdesk.id_server_host` when set)
   - **Key:** `public_key` value
   - Leave **Relay server** and **API server** blank for OSS

Optional: set `rustdesk.always_use_relay: true` to force relay usage (`ALWAYS_USE_RELAY=Y`).

## Related

- Schema: [`apps/hdc-cli/schema/rustdesk.config.schema.json`](../../../apps/hdc-cli/schema/rustdesk.config.schema.json)
- [RustDesk self-host docs](https://rustdesk.com/docs/en/self-host/)
