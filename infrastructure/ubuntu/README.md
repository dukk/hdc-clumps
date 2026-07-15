# Ubuntu server (`ubuntu`)

Infrastructure package for Ubuntu **hosts**: bootstrap the `hdc` Linux user and optional Docker container creation over SSH. Application stacks use service packages (e.g. `ollama`, `postfix-relay`) instead.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` with `bootstrap_hosts[]`.
- **Inventory:** optional system sidecars for hosts you manage.
- **Vault:** passwords for `bootstrap-hdc-user` when prompted or configured.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | `create-container` — run a Docker container on a bootstrap host |
| `maintain` | `bootstrap-hdc-user` — create/update local `hdc` user |
| `query` | Placeholder for future host health checks |

```bash
node apps/hdc-cli/cli.mjs run infrastructure ubuntu maintain --
node apps/hdc-cli/cli.mjs run infrastructure ubuntu deploy -- create-container
node apps/hdc-cli/cli.mjs users bootstrap-hdc --
node apps/hdc-cli/cli.mjs help run infrastructure ubuntu
```

CLI id is **`ubuntu`** (infrastructure). Home workstations use **`client-ubuntu`** under `clumps/clients/ubuntu/`.

## Common flags

Varies by subcommand. Shared: `--dry-run`, `--no-report`.

## After deploy / Using the service

No standalone web UI. After `maintain` / `users bootstrap-hdc`, SSH as the `hdc` user on bootstrap hosts listed in config. Service packages use `configure.ssh` on guests for installs.

## Related

- [AGENTS.md](../../../AGENTS.md)
- Home clients: [`clumps/clients/ubuntu/README.md`](../../clients/ubuntu/README.md) (`client-ubuntu`)
