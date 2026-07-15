# HDC agent runtime fleet (`hdc-agents`)

Proxmox LXC + Docker Compose on **hdc-agents-a**:

- One container per roster role (`hdc-manager` … `hdc-engineer`) via `apps/hdc-agent-server`
- **`hdc-scheduler`** — cron CLI jobs (`hdc_agents.schedules[]`)
- **`hdc-web`** — React ops UI / API (`apps/hdc-web-server` on `:9120`)

Model calls go through LiteLLM. Agent prompts/skills live under
`apps/hdc-agent-server/{agents,skills}/`. Schedule ticks use a **scripted dispatcher**
so idle loops do not call the model.

See [docs/multi-agent-ops.md](../../../docs/multi-agent-ops.md) and
[apps/hdc-agent-server/README.md](../../../apps/hdc-agent-server/README.md).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, `hdc_agents.litellm_base_url`, schedules, and optional `hdc_agents.public_url`
- **Inventory:** `inventory/manual/systems/hdc-agents-a.json`; `inventory/manual/services/hdc-agents.json`
- **Sizing:** defaults 4 vCPU / 8192 MB / 32 GB rootfs
- **Vault:** per-agent LiteLLM keys (`HDC_AGENT_LITELLM_KEY_<ROLE>`); deploy/maintain also mints scoped MCP keys (`HDC_MCP_API_KEY_<ROLE>`) and web secrets (`HDC_WEB_UI_SESSION_SECRET`, `HDC_WEB_API_TOKEN`). OIDC client secret `HDC_WEB_OIDC_CLIENT_SECRET` is minted by Keycloak maintain when the `hdc-web` client is declared. Registry hashes: `hdc-private/operations/mcp-api-keys.json`.
- **SSO:** set `hdc_agents.public_url` and `hdc_agents.oidc` (issuer / client_id). Apply Keycloak client first, then hdc-agents maintain.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker build/run fleet + scheduler + web; mint MCP API keys |
| `maintain` | Sync hdc trees, re-push compose/env/schedules, rebuild, guest baseline (`--skip-sync`, `--rotate-mcp-keys`) |
| `query` | Config summary; `--live` for Docker + `/health` on manager port |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service hdc-agents deploy -- --instance a
node apps/hdc-cli/cli.mjs run service hdc-agents query -- --live
node apps/hdc-cli/cli.mjs run service hdc-agents maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain; skips image rebuild), `--skip-sync`, `--rotate-mcp-keys`, `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **Web UI:** `https://hdc.dukk.org` (or `http://<ct-ip>:9120`) — Sign in with SSO (Keycloak `dukk-sso` / client `hdc-web`).
2. **Manager A2A:** `http://<ct-ip>:9200` (or deploy/query `upstream_url`).
3. Register agents on LiteLLM (`a2a_agents[]`) if not already present.
4. Confirm MCP keys: `operations/mcp-api-keys.json` + vault `HDC_MCP_API_KEY_*`.

**SSO apply order:** fix Keycloak admin vault password if needed → `hdc run service keycloak maintain -- --realm dukk-sso` → `hdc run service hdc-agents maintain --`.
