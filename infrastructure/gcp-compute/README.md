# GCP compute (HDC)

Deploy **Google Compute Engine VMs** and **Cloud Run** services with cost estimates and confirmation before provision.

## Config

Copy [`config.example.json`](config.example.json) to hdc-private as `clumps/infrastructure/gcp-compute/config.json`.

## Secrets

| Name | Where |
|------|--------|
| `HDC_GCP_COMPUTE_PROJECT_ID` | `.env` |
| `HDC_GCP_COMPUTE_SERVICE_ACCOUNT_JSON` | vault (full service account key JSON) |

Roles: Compute Admin (or narrower VM + disk scopes), Cloud Run Admin, Service Account User.

## Commands

```bash
node apps/hdc-cli/cli.mjs run infrastructure gcp-compute query --
node apps/hdc-cli/cli.mjs run infrastructure gcp-compute deploy -- --instance a --dry-run
node apps/hdc-cli/cli.mjs run infrastructure gcp-compute deploy -- --instance a
node apps/hdc-cli/cli.mjs run infrastructure gcp-compute maintain --
node apps/hdc-cli/cli.mjs run infrastructure gcp-compute teardown -- --instance a --yes
```

See [`docs/manually-deployed/gcp-compute.md`](../../../docs/manually-deployed/gcp-compute.md).
