# windows-desktop

Deploy **Windows 11** on Proxmox **QEMU** with generated `autounattend.xml`. Recommended workflow: build a **verified ISO template** once, then deploy instances by **full clone** with per-instance autounattend and **OEM MSDM/SLIC** passthrough (one Windows VM per hypervisor).

## Deploy modes

| Mode | Use |
| --- | --- |
| `proxmox-qemu-clone` (default) | Full clone from `proxmox.template.vmid`; specialize-only autounattend on first boot; OEM on instance only |
| `proxmox-qemu-iso` | One-shot install from Windows ISO every deploy (legacy) |

## Prerequisites

1. **Proxmox** — `clumps/infrastructure/proxmox/config.json` with target host (e.g. `pve-a`) and API token in vault.
2. **ISO files on the node** (upload or optional `download_url` + `sha256` verify):
   - Windows 11 installation ISO — match `proxmox.iso.windows_volid`.
   - [VirtIO drivers ISO](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso) (`virtio-win.iso`; use **`stable-virtio`**, not `stable/`).
3. **`local-lvm` disks** — use `disk_format: "raw"` (default on `local-lvm`; qcow2 fails on LVM-thin).
4. **OEM license** — Physical host must expose MSDM/SLIC in ACPI. OEM passthrough applies on **instance deploy**, not on the template builder.
5. **Vault** — `HDC_WINDOWS_DESKTOP_ADMIN_PASSWORD`.

## Config

Copy [`config.example.json`](config.example.json) to **hdc-private**: `clumps/services/windows-desktop/config.json`.

Key blocks:

- `defaults.mode` — `proxmox-qemu-clone` or `proxmox-qemu-iso`
- `defaults.proxmox.template` — builder/template `vmid` (e.g. `9001`), `name`
- `defaults.proxmox.iso` — `windows_volid`, `virtio_volid`, optional `download_url`, **`sha256`** (verify before template build)
- `defaults.proxmox.qemu.disk_format` — `raw` for `local-lvm`

## Operator workflow

### 1. Verified ISO (once)

Download Windows 11 from [Microsoft](https://www.microsoft.com/software-download/windows11), upload to the node, set `iso.sha256` in hdc-private config. Optional: set `download_url` + `sha256` for automated download/verify.

### 2. Build template (once per hypervisor)

```bash
node apps/hdc-cli/cli.mjs run service windows-desktop deploy -- \
  --build-template --destroy-existing --wait-install
```

Flags: `--force-rebuild-template`, `--refresh-iso`, `--skip-sysprep` (manual sysprep via console), `--install-timeout-minutes 120`.

Builder VM runs full unattended install → Sysprep `/generalize /oobe /shutdown` → Proxmox template conversion. **No OEM** on builder.

### 3. Deploy instance

```bash
node apps/hdc-cli/cli.mjs run service windows-desktop deploy -- \
  --instance a --destroy-existing --wait-install
```

Clone from template → OEM ACPI passthrough → specialize-only autounattend (hostname, admin password, static IP).

## Other commands

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_WINDOWS_DESKTOP_ADMIN_PASSWORD

node apps/hdc-cli/cli.mjs run service windows-desktop query -- --live

node apps/hdc-cli/cli.mjs run service windows-desktop maintain -- --instance a

node apps/hdc-cli/cli.mjs run infrastructure proxmox maintain --
```

Deploy flags: `--destroy-existing`, `--skip-oem`, `--skip-install`, `--wait-install`, `--install-timeout-minutes`.

## OEM activation notes

- hdc dumps ACPI tables to `/etc/pve/nodes/<pve_node>/qemu-server/MSDM_table` (and `SLIC_table` when present) and sets VM `args: -acpitable` plus `smbios1` from host `dmidecode`.
- Activation can take time after first boot; match CPU/RAM/disk roughly to the original OEM hardware if needed.
- Legal compliance for OEM licensing on virtualized hardware is the operator’s responsibility.

## Manual fallback

If unattended setup cannot find the VirtIO SCSI driver, use the Proxmox console during install: **Load driver** from the virtio ISO (`vioscsi` / Win11 amd64). Autounattend paths assume virtio ISO as drive **E:**.

If Sysprep fails over guest agent, use `--skip-sysprep`, run Sysprep manually in the builder VM console, then re-run template build.

## Limits

- No GPU/USB passthrough in v1.
- Install completion detection is best-effort (`--wait-install` polls VM power state).
- Windows guests do not receive the Linux guest baseline (ClamAV / `HDC_ADMIN_USER`).
- No cluster-wide template replication in v1.
