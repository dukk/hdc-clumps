# Open WebUI (`open-webui`)

Chat UI for Ollama and optional OpenAI-compatible backends (e.g. LiteLLM) on Proxmox LXC (Docker Compose, port from `open_webui.host_port`, default **3000**).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `ollama_backends[].url` to reachable Ollama APIs; optional `openai_backends[]` for LiteLLM / OpenAI-compatible gateways
- **Inventory:** [`inventory/manual/systems/open-webui-a.json`](../../../inventory/manual/systems/open-webui-a.json); [`inventory/manual/services/open-webui.json`](../../../inventory/manual/services/open-webui.json)
- **Vault:** `HDC_OPEN_WEBUI_SECRET_KEY` (required); per `openai_backends[].api_key_vault_key` (e.g. `HDC_LITELLM_MASTER_KEY`)
- **Ollama:** deploy [ollama](../ollama/README.md) separately; example backend URL in config: `http://192.0.2.25:11434` for `vm-ollama-a`
- **LiteLLM (optional):** deploy [litellm](../litellm/README.md); set `openai_backends[].url` to `http://<litellm-ip>:4000/v1`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Open WebUI (`OLLAMA_BASE_URLS`; optional `OPENAI_API_*`) |
| `maintain` | Re-push `.env`; `docker compose pull` + `up -d` |
| `query` | Config summary; `--live` for HTTP on `host_port` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service open-webui deploy --
node apps/hdc-cli/cli.mjs run service open-webui query -- --live
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--wipe-volumes` (compose `down -v` before install — clears users/data), `--skip-upgrade` (maintain), `--skip-compose-down`, `--dry-run`, `--yes`.

## After deploy

1. **Web UI (direct):** `http://<guest-ip>:3000` (or `open_webui.host_port` from config).
2. **LAN HTTPS (recommended):** set `open_webui.public_url` to `https://open-webui.home.example.invalid`, add nginx-waf site with `internal-lan` (upstream to guest port, WebSockets), flip BIND CNAME `open-webui` → `nginx-waf-a`, then `bind maintain` + `nginx-waf maintain`.
3. **First run:** create the admin account in the browser.
4. Confirm backends in the UI match `ollama_backends[]` / `openai_backends[]` URLs (must reach Ollama / LiteLLM on the LAN).

## Related

- [AGENTS.md — Open WebUI](../../../AGENTS.md)
- [ollama README](../ollama/README.md)
- [litellm README](../litellm/README.md)
- Schema: [`apps/hdc-cli/schema/open-webui.config.schema.json`](../../../apps/hdc-cli/schema/open-webui.config.schema.json)
