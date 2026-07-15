# Hermes Agent (`hermes`)

[Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) on Proxmox **QEMU Ubuntu VM** or LXC via Docker Compose (`nousresearch/hermes-agent` image). Primary LLM via local **Ollama** backends, **OpenRouter** fallback, optional **Discord** gateway bot.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (in hdc-private for production)
- **Inventory:** `inventory/manual/systems/hermes-a.json`; `inventory/manual/services/hermes.json`
- **Vault:**
  - `HDC_HERMES_OPENROUTER_API_KEY` (preferred) or `HDC_OPENROUTER_API_KEY` (shared fallback)
  - `HDC_HERMES_DASHBOARD_PASSWORD`
  - `HDC_HERMES_DISCORD_BOT_TOKEN` (when `hermes.discord.enabled` is true)
  - `HDC_HERMES_DASHBOARD_AUTH_SECRET` auto-generated on first deploy if missing
- **Ollama:** reachable backends in `hermes.ollama_backends[]` (e.g. `vm-ollama-a` / `vm-ollama-b`)
- **OpenRouter account:** optional credits/key lifecycle via [`clumps/infrastructure/openrouter`](../../infrastructure/openrouter/README.md)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU Ubuntu VM or LXC + Docker Compose (gateway + dashboard) |
| `maintain` | Re-push `.env`, `config.yaml`, `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for Docker/HTTP on dashboard port **9119** |
| `teardown` | Optional compose down, then destroy guest |

```bash
node apps/hdc-cli/cli.mjs run service hermes deploy -- --instance a
node apps/hdc-cli/cli.mjs run service hermes deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service hermes maintain --
node apps/hdc-cli/cli.mjs run service hermes query -- --live
```

## Modes

| Mode | Guest | Notes |
|------|-------|-------|
| `proxmox-qemu` | Ubuntu VM | Default; clone from cloud-init template, SSH install |
| `proxmox-lxc` | LXC | Privileged + Docker; legacy path |

## Model stack

| Layer | Config | Runtime |
|-------|--------|---------|
| Primary (Ollama) | `hermes.ollama_backends[]` + `hermes.model.default` | `config.yaml` → `provider: custom`, `base_url: http://<ollama>:11434/v1` |
| Fallback (cloud) | `hermes.fallback_providers[]` | Uses `OPENROUTER_API_KEY` in compose `.env` |
| Discord bot | `hermes.discord` + vault token | `DISCORD_BOT_TOKEN` in compose `.env` |

Set `hermes.model.default` to a model tag pulled on the primary Ollama host.

## Ports

| Port | Service |
|------|---------|
| 9119 | Web dashboard (basic auth) |
| 8642 | Gateway API (optional LAN use) |

## Common flags

`--instance a`, `--destroy-existing` (QEMU), `--skip-provision`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-clamav`, `--skip-admin-user`, `--skip-upgrade` (maintain), `--skip-compose-down` (teardown), `--dry-run`, `--yes`.

## After deploy

1. Get IP from `query --live` or inventory.
2. **Dashboard:** `http://<guest-ip>:9119` — sign in with `hermes.dashboard_username` and vault password.
3. **Discord:** invite the bot to your server; mention it in a channel (when `discord.require_mention` is true).
4. Check logs: `docker logs hermes` on the guest.

## Security notes

- Hermes runs tools with terminal access inside the container; treat the guest as a sensitive workload.
- Do not expose the dashboard on the public internet without OAuth or a reverse proxy with auth.
- Discord bot token lives in vault only; never commit values.

## hdc-private setup

1. Copy `config.example.json` to `hdc-private/clumps/services/hermes/config.json` (pick a free `vmid` and static IP).
2. Add inventory sidecars (see manifest `inventory_docs`).
3. Review `plan.md` before deploy.

## Related

- Schema: [`apps/hdc-cli/schema/hermes.config.schema.json`](../../../apps/hdc-cli/schema/hermes.config.schema.json)
- Upstream docs: [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/)
