# Nagios monitoring (`nagios`)

Deploy Nagios 4 on Proxmox LXC instances and generate checks from **BIND forward A records** in [`clumps/services/bind/config.json`](../bind/config.json).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (`deployments[]` for `nagios-a/b/c`; `bind_config_path` points at bind config)
- **BIND:** working [`bind`](../bind/README.md) config with forward zones — hosts for checks come from A records at deploy/maintain time
- **Inventory:** `nagios-*` sidecars with `automation_targets` including `nagios` and `proxmox`; Proxmox nodes `hypervisor-a`–`hypervisor-d` as needed
- **SSH/SCP:** required on the operator machine (e.g. Git for Windows OpenSSH tools)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Provision LXC (per deployment), install `nagios4`, push generated config from BIND |
| `maintain` | Regenerate config from BIND and reload all or selected instances |
| `query` | Service status per instance |

```bash
node apps/hdc-cli/cli.mjs run service nagios deploy --
node apps/hdc-cli/cli.mjs run service nagios maintain --
node apps/hdc-cli/cli.mjs run service nagios query --
```

## Common flags

`--instance a|b|c`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--apply-upgrades`, `--skip-upgrade` (maintain), `--dry-run`, `--no-report`.

Example IPs in `config.example.json`: `192.0.2.120`–`122` on `hypervisor-b` / `hypervisor-c` / `hypervisor-d`.

## After deploy

1. **Web UI:** `http://<guest-ip>/nagios4` (deploy JSON includes `ui_url` when configure SSH host is set). The UI is served by **Apache** with `mod_cgi` enabled (`a2enmod cgi`, `nagios4-cgi` conf) — deploy and maintain run this automatically; without it, `.cgi` links download instead of executing.
2. **New hosts to monitor:** add forward A records in BIND config, then `run nagios maintain --` (no per-host Nagios inventory entries for DNS-named systems).
3. Optional DNS names: `nagios-a.hdc.example.invalid`, etc. in BIND for operators — not required for checks.

## Related

- [bind README](../bind/README.md)
- [`.cursor/rules/hdc-nagios-monitoring.mdc`](../../../.cursor/rules/hdc-nagios-monitoring.mdc)
- Schema: [`apps/hdc-cli/schema/nagios.config.schema.json`](../../../apps/hdc-cli/schema/nagios.config.schema.json)
