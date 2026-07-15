# LiteLLM (`litellm`)

OpenAI-compatible AI gateway on Proxmox LXC (Docker Compose + bundled Postgres, port from `litellm.host_port`, default **4000**).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `ollama_backends[].url` and `model_list[]`
- **Inventory:** [`inventory/manual/systems/litellm-a.json`](../../../inventory/manual/systems/litellm-a.json); [`inventory/manual/services/litellm.json`](../../../inventory/manual/services/litellm.json)
- **Vault:** `HDC_LITELLM_MASTER_KEY`, `HDC_LITELLM_SALT_KEY`, `HDC_LITELLM_DB_PASSWORD` (auto-generated on first deploy if missing)
- **Optional:** `HDC_OPENROUTER_API_KEY` when any `model_list[]` entry uses `provider: openrouter`
- **Ollama:** deploy [ollama](../ollama/README.md) separately; reference backend URLs in `ollama_backends[]`
- **A2A gateway:** declare `litellm.a2a_agents[]` (`name`, `url`, optional `protocol_version` default `"0.3"`). Rendered into LiteLLM `agents:` on maintain. Per-agent virtual keys: `HDC_AGENT_LITELLM_KEY_<ROLE>` (vault). Register hdc-agents fleet containers (manager `:9200` … engineer `:9207`).

**Important:** `HDC_LITELLM_SALT_KEY` encrypts provider credentials stored in the database. Do not rotate it after models are added — set it once before first deploy.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker LiteLLM + Postgres |
| `maintain` | Re-push `config.yaml` + `.env`; `docker compose pull` + `up -d`; guest baseline. `--align-db-password` ALTERs the Postgres role to the vault password (fix P1000 drift). `--reset-db --yes` wipes `postgres_data` and recreates. |
| `query` | Config summary; `--live` for Docker + `/health/liveliness` + DB auth drift booleans + `/v1/models` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service litellm deploy --
node apps/hdc-cli/cli.mjs run service litellm query -- --live
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--align-db-password` (maintain — data-preserving password sync), `--reset-db --yes` (maintain — **destroys** `postgres_data`), `--skip-compose-down`, `--dry-run`, `--yes`.

```bash
# Prefer when LiteLLM shows Prisma P1000 after a vault password change:
node apps/hdc-cli/cli.mjs run service litellm maintain -- --align-db-password

# Wipe DB volumes and recreate from vault (loses spend/keys DB):
node apps/hdc-cli/cli.mjs run service litellm maintain -- --reset-db --yes
```

`--reset-db` without `--yes` is refused.

## After deploy

1. **Admin UI:** `http://<guest-ip>:4000/ui` (master key from vault for API auth).
2. **Health:** `curl http://<guest-ip>:4000/health/liveliness`
3. **Consumers:** OpenAI-compatible base URL `http://<guest-ip>:4000/v1` with `Authorization: Bearer <virtual-key-or-master-key>`.
4. **Virtual keys:** create per-app keys in the admin UI for spend tracking and rate limits.
5. **HTTPS (optional):** add nginx-waf upstream with extended proxy timeouts for long completions; set `litellm.public_url` when wiring a hostname.
6. **Email (optional):** set `litellm.mail.enabled` and `litellm.mail.from` (e.g. `litellm@hdc.dukk.org`) to send invites/key emails via internal **postfix-relay** (`SMTP_HOST` / no auth). Maintain pushes `callbacks: smtp_email` and `general_settings.alerts: [email]`.

## Model groups and routing groups

LiteLLM load-balances multiple `model_list[]` rows that share the same `model_name`. Use optional **`order`** (integer ≥ 1) on each deployment for capability priority — lower order is tried first; on failure the router escalates to the next order tier.

**Routing groups** (`router_settings.routing_groups[]`) bind a `group_name`, `models[]`, and per-group `routing_strategy`. For a local-only alias such as `lan-best-available`, use `simple-shuffle` at the group level and drive selection with deployment `order`.

Example: five local deployments under `lan-best-available` with orders 1–5 (best local model first), plus a routing group named `lan-best-available` targeting that alias.

## Complexity auto routers

Use `provider: auto_router` with `model: complexity_router` to expose a LiteLLM complexity router alias (e.g. `auto`, `lan-auto`). Map `complexity_router_config.tiers` (`SIMPLE` / `MEDIUM` / `COMPLEX` / `REASONING`) to existing `model_name` aliases and set `complexity_router_default_model`. No embedding backend is required.

## Related

- Schema: [`apps/hdc-cli/schema/litellm.config.schema.json`](../../../apps/hdc-cli/schema/litellm.config.schema.json)
- [ollama README](../ollama/README.md)
- [openrouter infrastructure package](../../infrastructure/openrouter/README.md)
