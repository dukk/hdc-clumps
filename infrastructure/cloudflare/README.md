# Cloudflare (`cloudflare`)

Discover zones in your Cloudflare account and apply declarative DNS records, Page Rules, and Email Routing rules from clump config.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` in hdc-private (same path).
- **API token:** `HDC_CLOUDFLARE_API_TOKEN` in repo `.env` or the hdc vault (`secrets set`; used when `.env` is unset).
- **Permissions:** Zone **Read**, DNS **Edit**, Page Rules **Edit**, Email Routing Rules **Edit** (for full sync).
- **Optional env:** `HDC_CLOUDFLARE_ACCOUNT_ID` when listing zones requires an account filter.

See [`docs/manually-deployed/cloudflare.md`](../../../docs/manually-deployed/cloudflare.md) for token setup.

## Commands

| Verb | Purpose |
|------|---------|
| `query` | List account zones, diff DNS/page rules/email routing vs config (JSON on stdout) |
| `maintain` | Apply managed DNS, page rules, and email routing for zones in config |

```bash
node apps/hdc-cli/cli.mjs run infrastructure cloudflare query --
node apps/hdc-cli/cli.mjs run infrastructure cloudflare maintain -- --dry-run
node apps/hdc-cli/cli.mjs help run infrastructure cloudflare
```

## Bootstrap config from live Cloudflare

Import DNS for all zones matching `cloudflare.zone_filter` (default: entire account):

```bash
node apps/hdc-cli/cli.mjs run infrastructure cloudflare query -- --import-zones --yes
```

Import page rules or email routing into **existing** config zones (merge):

```bash
node apps/hdc-cli/cli.mjs run infrastructure cloudflare query -- --import-page-rules --yes
node apps/hdc-cli/cli.mjs run infrastructure cloudflare query -- --import-email-routing --yes
```

Preview without writing: omit import flags and inspect `discovered_zones[]` in query JSON.

Limit to one apex: `--zone example.invalid` (with or without import flags).

## Config

- **`cloudflare.zone_filter`:** `all`, `include`, or `exclude` zone names (apex FQDN).
- **`zones[]`:** zones hdc **manages**. `--import-zones` replaces the whole `zones[]` array (DNS only).
- **Records:** `type`, `name` (`@` for apex), `data`, optional `ttl`, `priority` (MX), `proxied` (A/AAAA/CNAME).
- **`page_rules[]`:** optional per zone; include key (even `[]`) to manage. Stable `id`, optional `cf_id`, `priority`, `status`, `target`, `actions`.
- **`email_routing_rules[]`:** optional per zone; literal `to` matchers and forward/drop/worker actions.
- **`email_routing.catch_all`:** optional catch-all rule when the key is present under `email_routing`.

Omit `page_rules`, `email_routing_rules`, or `email_routing` entirely to leave live Cloudflare rules untouched.

## Common flags

**query:** `--zone <name>`, `--import-zones`, `--import-page-rules`, `--import-email-routing`, `--yes` (skip import confirm)

**maintain:** `--zone <name>`, `--dry-run`, `--prune` (delete live resources not in config for managed keys), `--skip-page-rules`, `--skip-email-routing`, `--no-report`, `--report <path>`

## Notes

- **Page Rules** are a legacy Cloudflare product; new rule creation may fail on some accounts. Query/import/update of existing rules is the primary use case.
- **Email forwarding** requires destination addresses verified in the Cloudflare dashboard (account-level).

## Related

- Internal authoritative DNS: [`clumps/services/bind/`](../../services/bind/)
- [AGENTS.md](../../../AGENTS.md)
