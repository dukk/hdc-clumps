# WireGuard (`wireguard`)

Privileged Proxmox LXC WireGuard hub (`proxmox.lxc.unprivileged: 0`) managed by hdc.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json`
- **Inventory:** [`inventory/manual/systems/wireguard-a.json`](../../../inventory/manual/systems/wireguard-a.json), [`inventory/manual/services/wireguard.json`](../../../inventory/manual/services/wireguard.json)
- **Vault keys:** `HDC_WIREGUARD_PRIVATE_KEY` and peer `HDC_WIREGUARD_*` keys referenced in `wireguard.peers[]`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision + WireGuard apt install + `wg0.conf` apply |
| `maintain` | Re-render and re-apply `wg0.conf`; guest baseline |
| `query` | Config summary; `--live` checks `wg-quick@wg0` and `wg show` |
| `teardown` | Destroy LXC (`--dry-run`, `--yes`) |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_WIREGUARD_PRIVATE_KEY
node apps/hdc-cli/cli.mjs run service wireguard deploy --
node apps/hdc-cli/cli.mjs run service wireguard query -- --live
```

## Peer key model

Each peer item uses vault key names:

- `public_key_vault_key` → peer public key
- `preshared_key_vault_key` → peer PSK
- `allowed_ips[]` → routes for that peer

The hub private key is loaded from `wireguard.private_key_vault_key`.

## Related

- [AGENTS.md — WireGuard section](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/wireguard.config.schema.json`](../../../apps/hdc-cli/schema/wireguard.config.schema.json)
