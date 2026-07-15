# Jenkins (`jenkins`)

**Deploy is a stub** — hdc does not install Jenkins yet.

## Prerequisites

- **Inventory:** [`inventory/manual/systems/vm-jenkins-a.json`](../../../inventory/manual/systems/vm-jenkins-a.json)
- **Config:** optional `config.json` with `configure.ssh` for ClamAV maintain

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Stub — no remote install |
| `maintain` | ClamAV when SSH configure block exists |
| `query` | Summary stub |

```bash
node apps/hdc-cli/cli.mjs run service jenkins deploy --
node apps/hdc-cli/cli.mjs run service jenkins maintain --
```

## Common flags

`--skip-clamav`, `--dry-run`, `--no-report`.

## After deploy

Install Jenkins manually on the VM. Typical UI: **`http://<guest-ip>:8080`** (unlock with initial admin password from the server).

## Related

- [AGENTS.md — stub services](../../../AGENTS.md)
