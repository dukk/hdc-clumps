# Ollama LLM runtime (`ollama`)

Deploy Ollama on Proxmox LXC or QEMU (optional GPU passthrough on `vm-ollama-*`), or Docker on an Ubuntu SSH host.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (`deployments[]`; `vm-ollama-*` uses `proxmox.qemu.hostpci[]` for GPU)
- **Inventory:** [`inventory/manual/systems/vm-ollama-a.json`](../../../inventory/manual/systems/vm-ollama-a.json); optional `ollama-b/c`
- **Vault:** none required for default install
- **GPU (QEMU):** complete VFIO/IOMMU on the Proxmox host before deploy; PCI BDF from `lspci` on the hypervisor

## Models in config

Declare desired Ollama library names under `defaults.ollama.models[]` and/or per `deployments[]` entry (merged like `install`):

```json
"ollama": {
  "models": ["llama3.2:latest", "nomic-embed-text"]
}
```

Per-deployment `ollama.models` replaces the merged default list for that node only (useful when the GPU VM hosts larger models than LXC workers).

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC or QEMU provision + Ollama install; pulls configured models after install |
| `maintain` | `ollama pull` missing models; `ollama rm` extras only with `--prune`; guest baseline on LXC/QEMU |
| `query` | Config summaries; `--live` for installed model tags |
| `teardown` | Destroy LXC or QEMU guest |

```bash
node apps/hdc-cli/cli.mjs run service ollama deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service ollama maintain --
node apps/hdc-cli/cli.mjs run service ollama maintain -- --instance a --prune --dry-run
node apps/hdc-cli/cli.mjs run service ollama query -- --live
node apps/hdc-cli/cli.mjs run service ollama teardown -- --instance a --yes
```

## Common flags

`--instance a|b|c`, `--system-id vm-ollama-a`, `--skip-install`, `--skip-models`, `--skip-existing`, `--redeploy-existing`, `--destroy-existing`, `--prune` (maintain only), `--dry-run` (maintain), LXC `--password` (or vault/env), `--dry-run`, `--yes` (teardown).

## After deploy

1. **Guest IP:** `node apps/hdc-cli/cli.mjs run service ollama query --` or inventory sidecar → `access.nodes[].ip`.
2. **API:** `http://<guest-ip>:11434` (`OLLAMA_HOST=0.0.0.0` in systemd; Docker uses `ubuntu.docker.host_port`, default **11434**).
3. **Models:** `maintain` syncs config; or `curl http://<ip>:11434/api/tags` / `query --live`.
4. **Chat UI:** deploy [open-webui](../open-webui/README.md) and set `ollama_backends[].url` to this API URL.
5. **GPU node:** migrating from LXC — run `teardown --instance a --yes` before QEMU redeploy.

## Related

- [AGENTS.md — Ollama](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/ollama.config.schema.json`](../../../apps/hdc-cli/schema/ollama.config.schema.json)
- [open-webui README](../open-webui/README.md)
