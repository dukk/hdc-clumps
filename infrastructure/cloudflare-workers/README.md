# Cloudflare Workers and Pages (hdc)

Deploy **Workers** and **Pages** (including Pages Functions) from project trees in **hdc-private** using **wrangler**. Sync routes and secrets via the Cloudflare API on `maintain`.

DNS remains in the separate [`cloudflare`](../cloudflare/) package.

## Prerequisites

1. **Wrangler** v4+ on PATH (`npm install -g wrangler`) or as a devDependency in each project.
2. **API token** — same as DNS: `HDC_CLOUDFLARE_API_TOKEN` (vault or `.env`).
3. **Account id** — `HDC_CLOUDFLARE_ACCOUNT_ID` in `.env` or `cloudflare_workers.account_id` in config.

Token permissions (minimum):

- Account → Workers Scripts → Edit
- Account → Workers Routes → Edit
- Account → Cloudflare Pages → Edit

## Layout (hdc-private)

```
clumps/infrastructure/cloudflare-workers/
  config.json
  workers/<id>/
    wrangler.jsonc
    package.json
    src/index.ts
  pages/<id>/
    package.json
    functions/          # Pages Functions (optional)
    dist/               # build output for pages deploy
```

Copy [`config.example.json`](config.example.json) to hdc-private as `config.json`.

## Commands

```bash
node apps/hdc-cli/cli.mjs run infrastructure cloudflare-workers query --
node apps/hdc-cli/cli.mjs run infrastructure cloudflare-workers query -- --import --yes
node apps/hdc-cli/cli.mjs run infrastructure cloudflare-workers deploy --
node apps/hdc-cli/cli.mjs run infrastructure cloudflare-workers deploy -- --worker example-worker
node apps/hdc-cli/cli.mjs run infrastructure cloudflare-workers maintain --
node apps/hdc-cli/cli.mjs run infrastructure cloudflare-workers maintain -- --redeploy
node apps/hdc-cli/cli.mjs run infrastructure cloudflare-workers teardown -- --worker example-worker --yes
```

## Verbs

| Verb | Summary |
| --- | --- |
| `query` | List scripts, routes, Pages projects; diff vs config; `--import --yes` bootstraps `workers[]` / `pages[]` |
| `deploy` | `wrangler deploy` / `wrangler pages deploy`; push secrets from vault |
| `maintain` | Sync routes + secrets (no code upload unless `--redeploy`) |
| `teardown` | `wrangler delete` / `wrangler pages project delete` (requires `--yes`) |

See [`docs/manually-deployed/cloudflare-workers.md`](../../../docs/manually-deployed/cloudflare-workers.md).
