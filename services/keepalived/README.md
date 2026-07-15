# Keepalived (VRRP + LVS)

HDC package for **Keepalived** directors (VRRP floating VIPs + optional LVS `virtual_server` blocks) and **real-server prep** on existing Linux guests.

## Config

Copy [`config.example.json`](config.example.json) to hdc-private `clumps/services/keepalived/config.json`.

- **`vrrp_instances[]`** — VRRP groups (`virtual_router_id`, `interface`, `virtual_ipaddress`, optional `track_scripts`)
- **`virtual_servers[]`** — LVS frontends (`lb_kind`: `NAT`, `DR`, or `TUN`; `real_servers[]`)
- **`deployments[]`** — `deployment_kind`: `director` (master/backup) or `real_server` (configure-only on backends)

Directors support `mode`: `proxmox-qemu` (provision Ubuntu VM) or `configure-only` (SSH to existing host). Real servers are always `configure-only`.

Vault: `HDC_KEEPALIVED_AUTH_PASS` (max **8 characters** — keepalived limit; auto-generated on first deploy when missing).

## Verbs

| Verb | Summary |
| --- | --- |
| `deploy` | MASTER director first, then BACKUP, then real servers; QEMU clone or configure-only |
| `maintain` | Re-push configs, optional apt upgrade, guest baseline on QEMU directors |
| `query` | Config summary; `--live` for VIP holder, `ipvsadm`, DR loopback checks |
| `teardown` | Destroy **QEMU director** guests only (`--yes`; never touches real_server systems) |

## Flags (after `--`)

- `--instance a` / `--system-id vm-keepalived-a`
- `--skip-provision`, `--skip-install`, `--destroy-existing`, `--skip-existing`, `--redeploy-existing`
- `--director-only`, `--real-server-only`
- `--skip-package-upgrade` (maintain)
- `--dry-run` (maintain, teardown)
- `--live` (query)
- `--yes` (teardown)

## LB modes

| `lb_kind` | Director | Real server prep |
| --- | --- | --- |
| **NAT** | `net.ipv4.ip_forward=1` | Warn if default route does not use director VIP |
| **DR** | Standard VRRP + ipvs | `lo` VIP + `arp_ignore` / `arp_announce` sysctl |
| **TUN** | VRRP + ipvs | Manual tunnel setup (no automatic prep) |

## After deploy

1. `node apps/hdc-cli/cli.mjs run service keepalived query -- --live` — confirm MASTER holds VIP.
2. Add BIND A record for the VIP when publishing a hostname.
3. Point nginx-waf upstreams (or Cloudflare) at the VIP instead of per-node IPs.
4. Update inventory `access.nodes[].ip` on director systems from query output.

## Example

```bash
node apps/hdc-cli/cli.mjs run service keepalived deploy --
node apps/hdc-cli/cli.mjs run service keepalived maintain --
node apps/hdc-cli/cli.mjs run service keepalived query -- --live
```
