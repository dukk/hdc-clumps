# Raspberry Pi clients (`raspberrypi`)

Same as **client-ubuntu**: SSH disk checks and `apt` maintenance for Pis (or any Debian-based host) in [`config.json`](config.json).

## Prerequisites

- **Config:** [`config.json`](config.json) from [`config.example.json`](config.example.json).
- **Inventory:** client system sidecars with SSH access.
- **Env:** `HDC_CLIENT_SSH_USER`.

## Commands

| Verb | Purpose |
|------|---------|
| `maintain` | `df`, apt dist-upgrade; `--reboot` to restart |
| `query` | Disk + upgradable package count; `--import-hardware --yes` fills `hardware[]` on inventory sidecars via SSH |

```bash
hdc run client raspberrypi query -- --no-wol
hdc run client raspberrypi query -- --import-hardware --yes --no-wol
hdc run client raspberrypi maintain --
hdc help run client raspberrypi
```

## Common flags

`--host-id <id>`, `--dry-run`, `--skip-updates`, `--reboot`, `--no-wol`, `--no-report`, `--report <path>`, `--import-hardware` (with `--yes`; ubuntu/raspberrypi only).

## After deploy / Using the service

SSH to the Pi as you normally would. This package does not install applications on the Pi beyond running system updates when requested.

## Related

- [client-ubuntu README](../ubuntu/README.md) (identical flags/behavior)
- [Clients overview](../README.md)
