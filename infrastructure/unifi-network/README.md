# UniFi Network (`unifi-network`)

Pull sites, clients, networks, firewall policies, and port forwards from the UniFi Network API. Maintain applies `port_forwards[]` from config to the controller, optional IP blocks, and optional **client alias** sync for Proxmox guests.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` (hdc-private).
- **Vault:** `HDC_UNIFI_NETWORK_API_KEY` — API key from Settings → Control Plane → Integrations (local admin with API access).
- **Env (optional):** `HDC_UNIFI_CONTROLLER_URL`, `HDC_UNIFI_SITE_ID`, `HDC_UNIFI_TLS_INSECURE=1` for self-signed gateway certs.

## Commands

| Verb | Purpose |
|------|---------|
| `query` | Network snapshot (JSON on stdout); optional `--import-port-forwards` |
| `maintain` | Apply managed `port_forwards[]`, IP blocks, and client aliases |

```bash
hdc run infrastructure unifi-network query --
hdc run infrastructure unifi-network maintain --
hdc help run infrastructure unifi-network
```

### Bootstrap port forwards from live

```bash
hdc run infrastructure unifi-network query -- --import-port-forwards --yes
```

Replaces `port_forwards[]` in hdc-private `config.json` with the current controller rules (all marked `managed: true`). Imported rules include `destination_ip` (WAN bind address) when the controller provides it.

## Port forward maintain behavior

Maintain **creates** managed `port_forwards[]` entries that are missing on the controller and **deletes** unmatched live rules only with `--prune`. When a live rule already matches (by `unifi_id` or destination/protocol/ports), it is left alone — maintain does **not** PUT/replace existing rules (avoids UniFi `PortForwardOverlaps` on cosmetic drift).

## Client aliases (Proxmox guests)

When `client_aliases.enabled` is `true`, full `maintain` sets each UniFi client **alias** (`name`) to the matching inventory **system id** for Proxmox guests (`system_class: virtual`, `hosted_on_system_id` matching `pve-*`). Match is by `access.nodes[].ip` (primary) or `mac` when present.

```json
"client_aliases": {
  "enabled": true
}
```

```bash
hdc run infrastructure unifi-network maintain -- --dry-run
hdc run infrastructure unifi-network maintain --
hdc run infrastructure unifi-network maintain -- --skip-client-aliases
```

Selective maintain (`--block` / `--unblock` / `--rule`) does not run alias sync. Non-Proxmox clients (phones, `lan-*`, APs) are never renamed.

## Multi-WAN public IPs

When the gateway has multiple public WAN addresses, each port forward must set UniFi **`destination_ip`** (not just `pfwd_interface: "wan"`). Otherwise UniFi treats rules as competing for the same WAN port.

1. Add a top-level **`wan_ips`** map (`.234` → your public IP) and keep rule names like `NGINX-WAF-A HTTP (.234)`, **or**
2. Set **`destination_ip`** explicitly on each `port_forwards[]` entry.

Use `any` only when a single public IP or intentionally binding to all WAN addresses.

## Common flags

**query:** `--import-port-forwards`, `--yes` (skip import confirmation)

**maintain:** `--dry-run`, `--prune` (delete live rules not in config), `--rule <id>`, `--skip-client-aliases`, `--skip-port-forwards`, `--no-report`, `--report <path>`

## Related

- Schema: [`apps/hdc-cli/schema/unifi-network.config.schema.json`](../../../hdc/apps/hdc-cli/schema/unifi-network.config.schema.json)
