# Zabbix (`zabbix`)

Single-node Zabbix stack on Proxmox using the official [zabbix/zabbix-docker](https://github.com/zabbix/zabbix-docker) Compose files.

## Deployment modes

| Mode | `system_id` | Guest access |
|------|-------------|--------------|
| `proxmox-lxc` | `zabbix-a` | `pct exec` on hypervisor |
| `proxmox-qemu` | `vm-zabbix-a` | SSH to `configure.ssh.host` |

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` in hdc-private
- **Inventory:** `inventory/manual/systems/zabbix-a.json` (LXC) or `vm-zabbix-a.json` (QEMU); [`inventory/manual/services/zabbix.json`](../../../inventory/manual/services/zabbix.json)
- **Vault:** `HDC_ZABBIX_DB_PASSWORD` (auto-generated on first deploy if missing); `HDC_ZABBIX_DB_ROOT_PASSWORD` when `zabbix.database` is `mysql`

## Stack

- Default database: **PostgreSQL** (`compose_pgsql.yaml`)
- Optional: `zabbix.database: "mysql"` → `compose.yaml`
- Minimal profile: Zabbix server + web (nginx) + bundled database

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC or QEMU + Docker Compose Zabbix install |
| `maintain` | Refresh compose env/images + guest Linux baseline |
| `query` | Config summary; `--live` for docker/web checks |
| `teardown` | Optional compose down, then destroy LXC or QEMU guest |

```bash
node apps/hdc-cli/cli.mjs run service zabbix deploy --
node apps/hdc-cli/cli.mjs run service zabbix deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service zabbix query -- --live
```

QEMU example deployment block (merge into `config.json`):

```json
{
  "system_id": "vm-zabbix-a",
  "hostname": "zabbix-a",
  "mode": "proxmox-qemu",
  "proxmox": {
    "host_id": "pve-b",
    "qemu": { "vmid": 563, "ip": "192.0.2.203/24", "template_vmid": 9022 }
  },
  "configure": { "ssh": { "host": "192.0.2.203" } }
}
```

## First login

After deploy, browse `http://<guest-ip>/`. Default credentials are **Admin** / **zabbix** until you change the password in the web UI on first login.

## Out of scope (v1)

- Zabbix agent enrollment on Linux guests (guest baseline installs Wazuh/CrowdSec only)
- External/shared PostgreSQL VM
- BIND / nginx-waf / Cloudflare (configure separately after deploy)

## Related

- Schema: [`apps/hdc-cli/schema/zabbix.config.schema.json`](../../../apps/hdc-cli/schema/zabbix.config.schema.json)
