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
| `maintain` | PATCH managed apps when config drifts from live; upload icon when `icon.repo_path` is set |

```bash
hdc run infrastructure discord query --
hdc run infrastructure discord query -- --import --yes
hdc run infrastructure discord maintain -- --dry-run
```

## Config

- **`discord`:** optional `api_base_url` (default Discord REST v10).
- **`applications[]`:** declare each app with `bot_token_vault_key`; only `"managed": true` entries are updated by maintain.
- **`match.application_id`:** set after first successful `query --import`.
- **`icon.repo_path`:** optional; relative to the **hdc** repo root (same image as Slack `hdc` app). Maintain uploads via `PATCH /applications/@me` when the local file hash differs from `icon.applied_sha256`. Skip with `--skip-icon`.

Discord has no public API to list or create applications — add each app to config after creating it in the [Developer Portal](https://discord.com/developers/applications).

## App icon

Set per-app `icon.repo_path` (e.g. `assets/beetle-agent.png`, shared with Slack). Maintain uploads the image as a data URI on `PATCH /applications/@me`. After a successful upload, `icon.applied_sha256` is written to hdc-private config; maintain re-uploads only when the local file changes.


## Related

- [AGENTS.md](../../../AGENTS.md)
- [Hermes](../../services/hermes/README.md) — consumes `HDC_HERMES_DISCORD_BOT_TOKEN`
