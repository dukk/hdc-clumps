# Home Ubuntu clients (`client-ubuntu`)

SSH disk checks and `apt` dist-upgrade for Linux workstations in [`config.json`](config.json).

**CLI id:** `client-ubuntu` (not infrastructure `ubuntu`).

## Prerequisites

- **Config:** [`config.json`](config.json) from [`config.example.json`](config.example.json).
- **Inventory:** client systems with `access.nodes[].ssh` or IP for SSH.
- **Env:** `HDC_CLIENT_SSH_USER` (optional; default often your SSH user).

## Commands

| Verb | Purpose |
|------|---------|
| `maintain` | `df`, `apt` dist-upgrade; reboot only with `--reboot` |
| `query` | Disk + upgradable package count |

```bash
node apps/hdc-cli/cli.mjs run client client-ubuntu query --
node apps/hdc-cli/cli.mjs run client client-ubuntu maintain -- --reboot --host-id ws-example
node apps/hdc-cli/cli.mjs help run client client-ubuntu
```

## Common flags

`--host-id <id>`, `--dry-run`, `--skip-updates`, `--reboot`, `--no-report`, `--report <path>`.

## After deploy / Using the service

No web UI from this package. Log in via SSH as usual; hdc only reports disk/update status and applies upgrades when you run `maintain`.

## Related

- [Clients overview](../README.md)
- [AGENTS.md — Home clients](../../../AGENTS.md)
