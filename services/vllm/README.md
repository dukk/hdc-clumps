# vLLM (`vllm`)

Deploy [vLLM](https://github.com/vllm-project/vllm) (OpenAI-compatible HTTP API) on **Proxmox QEMU** via Docker Compose. CUDA (NVIDIA) or CPU images.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private)
- **Inventory:** optional `inventory/manual/systems/vm-vllm-a.json`
- **Vault:** `HDC_HF_TOKEN` (required — Hugging Face hub token; not auto-generated)
- Set `vllm.model` (Hugging Face model id) on each deployment
- **CUDA:** VFIO/IOMMU on the Proxmox host; `proxmox.qemu.hostpci[]` from `lspci`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU clone + Docker CE + vLLM Compose (`install.device`: `cuda` \| `cpu`) |
| `maintain` | Re-push compose/`.env`, `docker compose pull` + `up -d`, guest Linux baseline |
| `query` | Config summary; `--live` for compose ps + `/health` + `/v1/models` |
| `teardown` | Optional compose down, then destroy QEMU guest |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_HF_TOKEN
node apps/hdc-cli/cli.mjs run service vllm deploy -- --instance a
node apps/hdc-cli/cli.mjs run service vllm query -- --live
node apps/hdc-cli/cli.mjs run service vllm maintain -- --instance a
```

## Deploy mode

| Mode | `system_id` | Notes |
|------|-------------|-------|
| `proxmox-qemu` | `vm-vllm-a` | Only supported mode; GPU via `hostpci[]` when `install.device` is `cuda` |

## Common flags

`--instance a`, `--system-id vm-vllm-a`, `--skip-install`, `--skip-provision`, `--destroy-existing`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-compose-down` (teardown), `--dry-run`, `--yes`.

## After deploy

1. **API:** `http://<guest-ip>:8000/v1` (`vllm.port`, default **8000**).
2. Health: `GET /health`; models: `GET /v1/models`.
3. Optional nginx-waf upstream: `http://<guest-ip>:8000`.

## Related

- Schema: [`apps/hdc-cli/schema/vllm.config.schema.json`](../../../apps/hdc-cli/schema/vllm.config.schema.json)
