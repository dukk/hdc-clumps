# Llama.cpp (`llama-cpp`)

Deploy `llama-server` on Proxmox LXC or QEMU from GitHub releases (CPU, CUDA, Vulkan, or ROCm backends).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** optional [`inventory/manual/systems/llama-cpp-a.json`](../../../inventory/manual/systems/llama-cpp-a.json) (LXC) or `vm-llama-cpp-a.json` (QEMU GPU)
- **Vault:** none required
- Set `server.model` or `server.hf_model` to enable the systemd unit at deploy
- **QEMU GPU:** complete VFIO/IOMMU on the Proxmox host before deploy; PCI BDF from `lspci` on the hypervisor (`proxmox.qemu.hostpci[]`)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC or QEMU + `llama-server` (`install.backend`: cpu/cuda/vulkan/rocm) |
| `maintain` | Upgrade binary; restart service; guest Linux baseline |
| `query` | Config summary; `--live` for systemd/health (and GPU name on QEMU CUDA) |
| `teardown` | Destroy LXC or QEMU guest |

```bash
node apps/hdc-cli/cli.mjs run service llama-cpp deploy -- --instance a
node apps/hdc-cli/cli.mjs run service llama-cpp deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service llama-cpp query -- --live
```

## Deploy modes

| Mode | `system_id` | GPU |
|------|-------------|-----|
| `proxmox-lxc` | `llama-cpp-a` | Manual device passthrough only (not automated) |
| `proxmox-qemu` | `vm-llama-cpp-a` | `proxmox.qemu.hostpci[]` + NVIDIA drivers when `install.backend` is `cuda` or `vulkan` (Ubuntu CUDA prebuilds are not published — use `vulkan` on Linux GPU) |

## Common flags

`--instance a|b`, `--skip-install`, `--skip-provision`, `--destroy-existing`, `--skip-existing`, `--redeploy-existing`, `--skip-restart` (maintain), `--dry-run`, `--yes`.

## After deploy

1. **HTTP API:** `http://<guest-ip>:8080` by default (`server.port` / `server.host` in config — default port **8080**, bind `0.0.0.0`).
2. Service stays **disabled** until `server.model` or `server.hf_model` is set in config.
3. Use OpenAI-compatible or llama.cpp client endpoints documented for `llama-server` against that URL.

## Related

- [AGENTS.md — Llama.cpp](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/llama-cpp.config.schema.json`](../../../apps/hdc-cli/schema/llama-cpp.config.schema.json)
