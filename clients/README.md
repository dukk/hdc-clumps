# Home clients

HDC packages for **physical workstations** and Pis: disk checks and OS updates over WinRM (Windows) or SSH (Linux). Not for Proxmox guests or NAS appliances.

## Per-clump config

Each client package has its own `config.json` (gitignored; copy from `config.example.json` in the same directory). Each host entry in `hosts[]` references inventory `system_id` and `access.nodes[]` (IP, MAC, `winrm` or `ssh`).

| CLI id | Config |
|--------|--------|
| `windows` | [`windows/config.json`](windows/config.json) |
| `client-ubuntu` | [`ubuntu/config.json`](ubuntu/config.json) |
| `raspberrypi` | [`raspberrypi/config.json`](raspberrypi/config.json) |

## Packages

| CLI id | Directory | Access |
|--------|-----------|--------|
| `windows` | [`windows/`](windows/) | WinRM (HTTPS 5986 typical) |
| `client-ubuntu` | [`ubuntu/`](ubuntu/) | SSH + apt |
| `raspberrypi` | [`raspberrypi/`](raspberrypi/) | SSH + apt (same behavior as client-ubuntu) |

```bash
node apps/hdc-cli/cli.mjs run client windows query --
node apps/hdc-cli/cli.mjs run client client-ubuntu maintain -- --host-id ws-example
node apps/hdc-cli/cli.mjs run client raspberrypi maintain --
```

## Inventory

Manual systems with `automation_targets: ["client"]` under `inventory/manual/systems/`.

## Manual setup docs

- [WinRM](../../../docs/manually-deployed/client-winrm.md)
- [Wake-on-LAN](../../../docs/manually-deployed/client-wol.md)

## Related

- [AGENTS.md — Home clients](../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/client.config.schema.json`](../../apps/hdc-cli/schema/client.config.schema.json)
