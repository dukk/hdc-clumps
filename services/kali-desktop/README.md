# Kali Linux desktop (Proxmox QEMU)

Deploy Kali Linux desktop VMs from a **cloud-init enabled QEMU template** on Proxmox.

## Config

Copy [`config.example.json`](config.example.json) to hdc-private `clumps/services/kali-desktop/config.json`.

## First-time template build

Requires on the Proxmox node: `libguestfs-tools`, `p7zip-full`.

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_KALI_DESKTOP_PASSWORD
node apps/hdc-cli/cli.mjs run service kali-desktop deploy -- --instance a --build-template
node apps/hdc-cli/cli.mjs run service kali-desktop deploy -- --instance a
node apps/hdc-cli/cli.mjs run service kali-desktop maintain --
```

## Verbs

| Verb | Summary |
| --- | --- |
| `deploy` | `--build-template` creates template from Kali QEMU image; clone + cloud-init static IP |
| `maintain` | Guest Linux baseline, optional apt upgrade, CPU/RAM sync |
| `query` | Config summary; `--live` for agent + SSH |
| `teardown` | Destroy QEMU guest (`--yes`) |

Vault: `HDC_KALI_DESKTOP_PASSWORD` (cloud-init password for user `kali`, default).
