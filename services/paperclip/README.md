# Paperclip (`paperclip`)

Self-hosted [Paperclip](https://github.com/paperclipai/paperclip) AI agent orchestration on Proxmox LXC (Docker Compose + PostgreSQL). LAN access uses **authenticated/private** mode by default; optional public HTTPS via **nginx-waf** when `paperclip.public_url` is set.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, optional static `ip_config`, and optional `paperclip.public_url` for nginx-waf
- **Inventory:** `inventory/manual/systems/paperclip-a.json`; `inventory/manual/services/paperclip.json`
- **Vault:** `HDC_PAPERCLIP_BETTER_AUTH_SECRET` and `HDC_PAPERCLIP_DB_PASSWORD` (auto-generated on first deploy if missing)
- **Optional:** `HDC_PAPERCLIP_CURSOR_API_KEY` → guest `CURSOR_API_KEY`; `HDC_PAPERCLIP_ANTHROPIC_API_KEY` → `ANTHROPIC_API_KEY`; `HDC_PAPERCLIP_OPENAI_API_KEY` → `OPENAI_API_KEY`; `HDC_PAPERCLIP_GOOGLE_GEMINI_API_KEY` → `GOOGLE_API_KEY` (vault key names configurable in config; clump `.env` or vault). Set `paperclip.ollama_backends[]` to push primary URL as guest `OLLAMA_BASE_URL`. In authenticated/strict mode you may still bind the same keys as company secrets in the Paperclip UI.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Paperclip + PostgreSQL |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline; syncs vault from live guest `.env` when secrets differ (never auto-wipes volumes) |
| `query` | Config summary; `--live` for `/api/health` |
| `query --bootstrap-company` | Import HDC skills + create/sync Paperclip agents (see [paperclip-hdc-company.md](../../../docs/manually-deployed/paperclip-hdc-company.md)) |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service paperclip deploy -- --instance a
node apps/hdc-cli/cli.mjs run service paperclip query -- --live
node apps/hdc-cli/cli.mjs run service paperclip maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--reset-db --yes` (maintain — **destroys** `paperclip-pgdata` and `paperclip-data`; claim instance again afterward), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## Maintain and secrets

Routine `maintain` **never** destroys Docker volumes when vault and guest passwords differ. Instead it **adopts** live `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` from `/opt/paperclip/.env` into vault (`HDC_PAPERCLIP_DB_PASSWORD`, `HDC_PAPERCLIP_BETTER_AUTH_SECRET`). This prevents the wipe loop that occurred when vault and guest drifted apart.

To factory-reset Paperclip (empty database, claim required):

```bash
node apps/hdc-cli/cli.mjs run service paperclip maintain -- --reset-db --yes
```

`--reset-db` without `--yes` is refused.

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.123:3100`).
2. **First admin:** open the LAN URL, sign in or register, then **Claim this instance** on the setup screen.
3. **Inventory:** set `access.nodes[0].ip` on `paperclip-a.json`.
4. **Optional HTTPS:** set `paperclip.public_url`, add BIND A record and nginx-waf upstream to the CT IP.
5. **Backup:** preserve vault keys and Docker volumes (`paperclip-pgdata`, `paperclip-data`).

## HDC agent company

After claim, bootstrap the **Home Data Center** company (skills + agents for hdc-web-server / agent fleet):

```bash
node apps/hdc-cli/cli.mjs run service paperclip query -- --bootstrap-company --dry-run
node apps/hdc-cli/cli.mjs run service paperclip query -- --bootstrap-company --yes
```

Skills live under [`skills/`](skills/). Manual runbook: [`docs/manually-deployed/paperclip-hdc-company.md`](../../../docs/manually-deployed/paperclip-hdc-company.md).

## Ollama and cloud model keys

After `maintain`, guest `/opt/paperclip/.env` receives optional provider keys and `OLLAMA_BASE_URL` (primary backend from `paperclip.ollama_backends[]`). HDC agents stay on Cursor adapters by default; use the Paperclip UI to try local models on any agent:

1. Agent → Adapter → **Ollama**, **OpenCode local**, or **OpenAI-compatible**
2. Primary Ollama: leave `baseUrl` empty (uses `OLLAMA_BASE_URL`) or set `http://<ollama-a-ip>:11434`
3. Secondary Ollama: set `baseUrl` to `http://<ollama-b-ip>:11434`
4. Run **Test environment** to discover models via `GET /api/tags`

See [paperclip-hdc-company.md — LLM providers](../../../docs/manually-deployed/paperclip-hdc-company.md#6-llm-providers-ollama-openai-gemini) for full UI steps.

## Image tags

Pin `paperclip.image_tag` to a [GitHub release tag](https://github.com/paperclipai/paperclip/releases) (e.g. `v2026.618.0`). `latest` works but is not recommended for production.

## Related

- [AGENTS.md — Paperclip](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/paperclip.config.schema.json`](../../../apps/hdc-cli/schema/paperclip.config.schema.json)
