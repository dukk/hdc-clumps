# HDC agent runtime fleet (`hdc-agents`)

Proxmox LXC + Docker Compose on **hdc-agents-a**:

- One container per roster role (`hdc-manager` … `hdc-qa` on ports 9200–9206, 9208–9209; no 9207) via `apps/hdc-agent-server`
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
- **Vault:** per-agent LiteLLM keys (`HDC_AGENT_LITELLM_KEY_<ROLE>`); deploy/maintain also mints scoped MCP keys (`HDC_MCP_API_KEY_<ROLE>`) and web secrets (`HDC_WEB_UI_SESSION_SECRET`, `HDC_WEB_API_TOKEN`). Optional initial web admin password: vault `HDC_WEB_ADMIN_PASSWORD` (used only when the admin user does not exist yet). OIDC (`HDC_WEB_OIDC_CLIENT_SECRET`) is opt-in via `hdc_agents.oidc` + Keycloak maintain. Registry hashes: `hdc-private/operations/mcp-api-keys.json`.
- **Web login (default):** encrypted htpasswd on first start (`admin` user); optional SSO when `hdc_agents.public_url` and `hdc_agents.oidc.issuer` are set. Apply Keycloak client first, then hdc-agents maintain.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker build/run fleet + scheduler + web; mint MCP API keys |
| `maintain` | Sync hdc trees, re-push compose/env/schedules, rebuild, guest baseline (`--skip-sync`, `--rotate-mcp-keys`) |
| `query` | Config summary; `--live` for Docker + `/health` on manager port |
| `teardown` | Optional compose down, destroy LXC |

```bash
hdc run service hdc-agents deploy -- --instance a
hdc run service hdc-agents query -- --live
hdc run service hdc-agents maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain; skips image rebuild), `--skip-sync`, `--rotate-mcp-keys`, `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **Web UI:** `http://<ct-ip>:9120` — sign in with the default admin password (check container logs on first start if auto-generated) or optional SSO when OIDC is configured.
2. **Manager A2A:** `http://<ct-ip>:9200` (or deploy/query `upstream_url`).
3. Register agents on LiteLLM (`a2a_agents[]`) if not already present.
4. Confirm MCP keys: `operations/mcp-api-keys.json` + vault `HDC_MCP_API_KEY_*`.

**SSO apply order:** fix Keycloak admin vault password if needed → `hdc run service keycloak maintain -- --realm dukk-sso` → `hdc run service hdc-agents maintain --`.
