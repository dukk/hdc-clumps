# LMS (LM Studio headless)

Proxmox **QEMU** Ubuntu guests running [llmster](https://lmstudio.ai/docs/developer/core/headless) via the official `install.sh` and `lms` CLI. Exposes an OpenAI-compatible HTTP API (default port **1234**).

## Config

Copy [`config.example.json`](config.example.json) to `clumps/services/lms/config.json` in **hdc-private** (or public hdc for local dev).

- `deployments[]` with `system_id` `vm-lms-a`, `vm-lms-b`, …
- Static `proxmox.qemu.ip` (CIDR) for cloud-init
- `configure.ssh` for post-clone install over SSH
- `lms.models[]` — downloaded with `lms get` on deploy/maintain
- `lms.load_on_start` — optional model loaded before `lms server start` (systemd)
- `install.gpu` + `install.gpu_backend: nvidia` — optional NVIDIA drivers (passthrough must be configured on the hypervisor first)

## Inventory

Manual sidecars (hdc-private):

- `inventory/manual/systems/vm-lms-a.json` — `kind: system`, `system_class: virtual`, `automation_targets: ["lms", "proxmox"]`
- `inventory/manual/services/lms.json` — `kind: services`

## Commands

```bash
node apps/hdc-cli/cli.mjs run service lms deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service lms maintain --
node apps/hdc-cli/cli.mjs run service lms query -- --live
node apps/hdc-cli/cli.mjs run service lms teardown -- --instance a --yes
```

### Deploy flags

`--instance`, `--system-id`, `--destroy-existing`, `--skip-provision`, `--skip-install`, `--skip-models`, `--skip-existing`, `--redeploy-existing`

### Maintain flags

`--skip-models`, `--skip-clamav`, `--skip-admin-user`, `--skip-resources`, `--no-reboot`, `--reboot`, `--dry-run`  
`--prune` is accepted but does not remove models (LM Studio CLI has no stable removal command in v1).

## GPU passthrough

Same as Ollama QEMU: set `proxmox.qemu.hostpci[]` with the PCI BDF from `lspci` on the hypervisor. Complete VFIO/IOMMU setup manually before deploy.

## API

After deploy: `http://<guest-ip>:1234/v1/models` (or configured `lms.server.port`).

No vault secrets for v1.
