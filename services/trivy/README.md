# Trivy (`trivy`)

Proxmox LXC node that installs Trivy from GitHub releases and runs configured remote SSH scans.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) -> `config.json`
- **Inventory:** [`inventory/manual/systems/trivy-a.json`](../../../inventory/manual/systems/trivy-a.json); [`inventory/manual/services/trivy.json`](../../../inventory/manual/services/trivy.json)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Trivy binary install |
| `maintain` | Upgrade Trivy and execute `scan_targets[]` scans |
| `query` | Config summary; `--live` for service/version checks |
| `teardown` | Destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service trivy deploy --
node apps/hdc-cli/cli.mjs run service trivy maintain --
```

## `scan_targets[]`

Each target supports:

- `host` (required): SSH host/IP
- `ssh_user` (optional): defaults to `HDC_GUEST_SSH_USER` or `hdc`
- `paths[]` (optional): filesystem paths scanned with `trivy fs`
- `docker_compose_dirs[]` (optional): resolved to compose images, scanned with `trivy image`

## Related

- [AGENTS.md — Trivy references](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/trivy.config.schema.json`](../../../apps/hdc-cli/schema/trivy.config.schema.json)
