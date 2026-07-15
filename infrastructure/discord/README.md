# Discord applications (`discord`)

Track Discord Developer applications in clump config, diff live metadata via each app's bot token, and maintain API-supported fields. Privileged Gateway Intents and application creation remain manual in the Developer Portal.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` in hdc-private (same path).
- **Vault:** per-app `bot_token_vault_key` (e.g. `HDC_HERMES_DISCORD_BOT_TOKEN` for Hermes).

See [`docs/manually-deployed/discord.md`](../../../docs/manually-deployed/discord.md) for bootstrap workflow.

## Commands

| Verb | Purpose |
|------|---------|
| `query` | Diff configured apps vs live `GET /applications/@me`; optional `--import --yes` |
| `maintain` | PATCH managed apps when config drifts from live |

```bash
node apps/hdc-cli/cli.mjs run infrastructure discord query --
node apps/hdc-cli/cli.mjs run infrastructure discord query -- --import --yes
node apps/hdc-cli/cli.mjs run infrastructure discord maintain -- --dry-run
```

## Config

- **`discord`:** optional `api_base_url` (default Discord REST v10).
- **`applications[]`:** declare each app with `bot_token_vault_key`; only `"managed": true` entries are updated by maintain.
- **`match.application_id`:** set after first successful `query --import`.

Discord has no public API to list or create applications — add each app to config after creating it in the [Developer Portal](https://discord.com/developers/applications).

## Related

- [AGENTS.md](../../../AGENTS.md)
- [Hermes](../../services/hermes/README.md) — consumes `HDC_HERMES_DISCORD_BOT_TOKEN`
