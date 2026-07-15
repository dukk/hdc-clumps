# Synology NAS (`synology-nas`)

Query and maintain Synology DSM hosts over SSH: versions, RAID, disk usage, DSM upgrades, package updates, and Docker/Container Manager.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json`.
- **Inventory:** [`inventory/manual/systems/nas-a.json`](../../../inventory/manual/systems/nas-a.json), [`nas-b.json`](../../../inventory/manual/systems/nas-b.json).
- **DSM:** enable SSH (Control Panel → Terminal & SNMP).
- **Vault:** `HDC_SYNOLOGY_SSH_USER` (optional); `HDC_SYNOLOGY_SSH_PASSWORD_NAS_1`, `HDC_SYNOLOGY_SSH_PASSWORD_NAS_2` for first bootstrap unless pubkey auth already works.

## Commands

| Verb | Purpose |
|------|---------|
| `query` | DSM version, volumes, RAID, disks, Docker status (JSON on stdout) |
| `maintain` | SSH keys, Docker ensure, DSM upgrade, `synopkg upgradeall` (one NAS at a time) |

```bash
node apps/hdc-cli/cli.mjs run infrastructure synology-nas query --
node apps/hdc-cli/cli.mjs run infrastructure synology-nas maintain --
node apps/hdc-cli/cli.mjs help run infrastructure synology-nas
```

## Common flags

`--instance a|b`, `--system-id nas-a`, `--skip-dsm-upgrade`, `--skip-package-upgrade`, `--skip-ssh-keys`, `--skip-docker-ensure`, `--dry-run`, `--no-report`, `--report <path>`.

## Docker / Container Manager

Maintain (by default) ensures **Container Manager** (DSM 7.2+) or legacy **Docker** package is installed and started via `synopkg`, then verifies `docker info`. Query reports package name, running state, version, and compose plugin availability (read-only).

If unattended `synopkg install` fails (EULA or Package Center constraints), install Container Manager manually in DSM, then re-run maintain.

Config defaults:

- `defaults.maintain.docker_ensure`: `true`
- `defaults.docker.compose_base_dir`: `/volume1/docker`

## Library API (for service packages)

Import from `clumps/infrastructure/synology-nas/lib/`:

| Module | Exports |
|--------|---------|
| `synology-exec-context.mjs` | `createSynologyExecContext` — deployment + SSH auth + `execOpts` |
| `synology-docker-ensure.mjs` | `ensureSynologyDocker`, `probeSynologyDocker`, `parseDockerSectionOutput` |
| `synology-docker-compose.mjs` | `deployComposeStack`, `maintainComposeStack`, `teardownComposeStack`, `composeDirFromStack`, `buildComposeUpScript` |
| `synology-docker-host-provisioner.mjs` | `createSynologyDockerHostProvisioner` — `HostProvisioner` with `backendId: synology-docker` |

Example:

```js
import { createSynologyExecContext } from "../../../infrastructure/synology-nas/lib/synology-exec-context.mjs";
import { deployComposeStack } from "../../../infrastructure/synology-nas/lib/synology-docker-compose.mjs";

const { execOpts, log } = await createSynologyExecContext({ cfg, flags, deps });
await deployComposeStack(
  execOpts,
  { dir: "/volume1/docker/myapp", composeYaml: rendered, pull: true },
  log,
);
```

Service deploy configs can use `mode: synology-docker` (same pattern as Ollama `ubuntu-docker`) with `createSynologyDockerHostProvisioner({ execOpts })`.

## After deploy / Using the service

1. **DSM web UI:** `https://<nas-ip>:5001` (or your DSM port from inventory `access.nodes[].web_ui`).
2. **SSH:** used by hdc for query/maintain; credentials from vault after bootstrap.
3. **Query output:** use JSON on stdout for automated inventory; update manual sidecar IPs when they change.

## Related

- [AGENTS.md — Synology NAS](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/synology-nas.config.schema.json`](../../../apps/hdc-cli/schema/synology-nas.config.schema.json)
