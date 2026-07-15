# GCP OAuth (`gcp-oauth`)

Declare Google Auth Platform OAuth 2.0 web clients per application, validate redirect URIs, diff against Console credential exports, and store client IDs/secrets in the hdc vault.

Google does **not** expose a stable public API to create Auth Platform clients (`*.apps.googleusercontent.com`). Create and update clients in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials); hdc automates declaration, drift detection, vault storage, and operator checklists.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` in hdc-private (same path).
- **Vault:** per-app keys such as `HDC_GCP_OAUTH_<APP>_CLIENT_ID` and `HDC_GCP_OAUTH_<APP>_CLIENT_SECRET` (see config `vault` block).

See [`docs/manually-deployed/gcp-oauth.md`](../../../docs/manually-deployed/gcp-oauth.md) for the full Console workflow.

## Commands

| Verb | Purpose |
|------|---------|
| `query` | Effective redirect URIs / origins per app; optional diff vs `--import` JSON; vault key presence |
| `maintain` | Validate config; `--import` writes vault; print Console checklist |

```bash
node apps/hdc-cli/cli.mjs run infrastructure gcp-oauth query --
node apps/hdc-cli/cli.mjs run infrastructure gcp-oauth query -- --import ./client_secret.json --require-vault
node apps/hdc-cli/cli.mjs run infrastructure gcp-oauth maintain -- --dry-run
node apps/hdc-cli/cli.mjs run infrastructure gcp-oauth maintain -- --import ./client_secret.json
node apps/hdc-cli/cli.mjs help run infrastructure gcp-oauth
```

## Config

- **`gcp.project_id`:** GCP project for Console links.
- **`applications[]`:** per-app redirect URIs, optional `derive_from` (nginx-waf hostname + callback path), vault key names, optional `existing_client_id` / `import_match`.
- **`derive_from`:** builds `https://{server_name}{callback_path}` from nginx-waf `sites[]`; explicit `redirect_uris` win when both are set (warnings if they differ).

## Common flags

`--app <id>`, `--import <path>`, `--require-vault`, `--no-derive`, `--dry-run`, `--skip-vault`, `--no-report`, `--report <path>`.

## Limitations

| Client type | hdc v1 |
|-------------|--------|
| Auth Platform (`*.apps.googleusercontent.com`) | Console + import/vault/checklist only |
| IAM Workforce `oauthClients` | Not in scope |
| IAP OAuth clients | Not in scope |

## Related

- Reverse proxy hostnames: [`clumps/services/nginx-waf/`](../../services/nginx-waf/)
- [AGENTS.md](../../../AGENTS.md)
