# Audiobookshelf (`audiobookshelf`)

Self-hosted audiobook and podcast server via [Audiobookshelf](https://www.audiobookshelf.org/) Docker Compose on Proxmox **QEMU**.

## Deploy mode

| Mode | System id | Guest access |
| --- | --- | --- |
| `proxmox-qemu` | `vm-audiobookshelf-a` | SSH + optional `data_disk_gb` on `data_disk_storage` (e.g. `local-lvm-data`) |

Libraries, SQLite config, and metadata live under `install.data_mount` (default `/data/audiobookshelf`).

## Config

Copy [`config.example.json`](config.example.json) to hdc-private `clumps/services/audiobookshelf/config.json`.

Key blocks:

- `audiobookshelf.public_url` — public HTTPS URL when behind nginx-waf (e.g. `https://bookshelf.example.invalid`)
- `audiobookshelf.host_port` — host port mapped to container port 80 (default **13378**)
- `install.compose_dir` — Docker Compose directory (default `/opt/audiobookshelf`)
- `install.data_mount` — mount point for libraries + `/config` + `/metadata` (default `/data/audiobookshelf`)

QEMU defaults: 4 vCPU, 8 GiB RAM, 32 GiB rootfs + optional data disk.

No vault secrets for v1 — users and settings are stored in SQLite under `/config`.

## Commands

```bash
node apps/hdc-cli/cli.mjs run service audiobookshelf deploy -- --instance a
node apps/hdc-cli/cli.mjs run service audiobookshelf deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service audiobookshelf maintain --
node apps/hdc-cli/cli.mjs run service audiobookshelf query -- --live
node apps/hdc-cli/cli.mjs run service audiobookshelf teardown -- --dry-run
```

### Flags

| Verb | Flags |
| --- | --- |
| `deploy` | `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--destroy-existing`, `--skip-provision` |
| `maintain` | `--skip-upgrade`, `--skip-clamav`, guest baseline skip flags |
| `query` | `--live` |
| `teardown` | `--dry-run`, `--yes`, `--skip-compose-down` |

## Dependencies (manual)

- **BIND** — forward A record `audiobookshelf-a` → guest IP
- **nginx-waf** — site upstream `http://<guest-ip>:13378` (WebSockets for playback)
- **Cloudflare** — optional; CNAME to WAF when proxied

## Migration

When moving from a legacy Docker host, rsync `config`, `metadata`, and library folders into `data_mount` subdirs preserving container paths (`/audiobooks`, `/podcasts`, `/config`, `/metadata`). Stop the source stack before the final rsync for a consistent SQLite copy.

## Related

- Inventory: [`inventory/manual/systems/vm-audiobookshelf-a.json`](../../../inventory/manual/systems/vm-audiobookshelf-a.json)
- Schema: [`apps/hdc-cli/schema/audiobookshelf.config.schema.json`](../../../apps/hdc-cli/schema/audiobookshelf.config.schema.json)
