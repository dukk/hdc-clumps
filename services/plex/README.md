# Plex (`plex`)

Plex Media Server on Synology NAS via the native **PlexMediaServer** DSM package (`synology-package` mode).

## Prerequisites

- **Synology NAS:** SSH enabled; [`synology-nas`](../../infrastructure/synology-nas/) config with `deployments[].instance` matching `plex.synology.instance`.
- **First install:** Install Plex manually in DSM (Package Center or `.spk` from [Plex.tv](https://www.plex.tv/media-server-downloads/)). Set `install.enabled: false` in config to adopt an existing server.
- **Config:** copy [`config.example.json`](config.example.json) to hdc-private `clumps/services/plex/config.json`.
- **Inventory:** `inventory/manual/systems/plex-a.json`, `inventory/manual/services/plex.json`; link from `nas-a` via `services[]`.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Verify package installed, start if stopped, HTTP probe on `:32400/identity` |
| `maintain` | `synopkg upgrade PlexMediaServer`; `--skip-upgrade` for health check only |
| `query` | Config summary; `--live` for synopkg status + HTTP probe |
| `teardown` | `synopkg stop` only (`--yes` required; does not uninstall) |

```bash
node apps/hdc-cli/cli.mjs run service plex query -- --live
node apps/hdc-cli/cli.mjs run service plex deploy --
node apps/hdc-cli/cli.mjs run service plex maintain -- --skip-upgrade
```

## Common flags

`--instance a`, `--system-id plex-a`, `--skip-install`, `--skip-upgrade`, `--dry-run`, `--yes` (teardown), `--no-report`.

## After deploy

Open **http://\<nas-ip\>:32400/web** and manage libraries in the Plex UI. hdc does not store Plex account credentials.

## Related

- [AGENTS.md — Plex](../../../AGENTS.md)
- [synology-nas](../../infrastructure/synology-nas/README.md)
