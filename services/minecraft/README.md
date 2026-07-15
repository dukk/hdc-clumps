# Minecraft server (`minecraft`)

**Deploy is a stub** — no automated Minecraft server install.

## Prerequisites

- **Inventory:** [`inventory/manual/systems/vm-minecraft-a.json`](../../../inventory/manual/systems/vm-minecraft-a.json)
- **Config:** optional `config.json` with `configure.ssh` for ClamAV maintain

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Stub — no remote changes |
| `maintain` | ClamAV on Ubuntu guest when SSH is configured |
| `query` | Summary stub |

```bash
node apps/hdc-cli/cli.mjs run service minecraft maintain --
```

## Common flags

`--skip-clamav`, `--dry-run`, `--no-report`.

## After deploy

Run a Minecraft server manually (Java edition default port **25565**). Clients connect with `minecraft://` or server list entry `<guest-ip>:25565`.

## Related

- [AGENTS.md — stub services](../../../AGENTS.md)
