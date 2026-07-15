# Wazuh (`wazuh`)

Single-node Wazuh stack on Proxmox using Docker Compose.

## Deployment modes

| Mode | `system_id` | Guest access |
|------|-------------|--------------|
| `proxmox-lxc` | `wazuh-a` | `pct exec` on hypervisor |
| `proxmox-qemu` | `vm-wazuh-a` | SSH to `configure.ssh.host` |

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) -> `config.json`
- **Inventory:** `inventory/manual/systems/wazuh-a.json` (LXC) or `vm-wazuh-a.json` (QEMU); [`inventory/manual/services/wazuh.json`](../../../inventory/manual/services/wazuh.json)
- **Vault:** `HDC_WAZUH_API_PASSWORD`, `HDC_WAZUH_AGENT_PASSWORD`
- **Proxmox:** `provision.guest_agents.wazuh.manager_host` → manager IP; vault `HDC_WAZUH_AGENT_PASSWORD`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC or QEMU + Docker Compose Wazuh install |
| `maintain` | Refresh compose env/images + baseline (`--skip-wazuh-agent` on manager) |
| `query` | Config summary; `--live` for docker/dashboard checks |
| `teardown` | Optional compose down, then destroy LXC or QEMU guest |

```bash
node apps/hdc-cli/cli.mjs run service wazuh deploy --
node apps/hdc-cli/cli.mjs run service wazuh deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service wazuh query -- --live
```

QEMU example deployment block (merge into `config.json`):

```json
{
  "system_id": "vm-wazuh-a",
  "hostname": "wazuh-a",
  "mode": "proxmox-qemu",
  "proxmox": {
    "host_id": "pve-b",
    "qemu": { "vmid": 562, "ip": "192.0.2.202/24", "template_vmid": 9022 }
  },
  "configure": { "ssh": { "host": "192.0.2.202" } }
}
```

## Alerting and agents

- Mail + OpenSearch channel: `defaults.mail` in config; skip with `--skip-wazuh-mail`.
- Dashboard monitors: created on maintain (skip with `--skip-dashboard-monitors`).
- Monitoring FP mute: `defaults.wazuh.alert_ignore.srcips[]` (CDB + local_rules level 0); skip with `--skip-alert-ignore`.
- Guest agents: proxmox `guest_agents.wazuh` + guest `maintain`; version pinned to `defaults.wazuh.release`.
- Log collection: nginx-waf, crowdsec, postfix-relay (see [`docs/manually-deployed/wazuh.md`](../../../docs/manually-deployed/wazuh.md)).

## Related

- [Operator guide](../../../docs/manually-deployed/wazuh.md)
- [AGENTS.md — Wazuh references](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/wazuh.config.schema.json`](../../../apps/hdc-cli/schema/wazuh.config.schema.json)
