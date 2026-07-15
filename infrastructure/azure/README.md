# Azure (Entra + compute)

One package for Microsoft Entra app registrations (Graph) and Azure VMs/ACI (ARM). Route with `--section entra|compute|all`.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to hdc-private `config.json` (schema v2: `entra` + `compute`; optional `$hdc.include` sidecars). Set `entra.automation.app_id` (default `hdc`).
- **Entra env:** `HDC_AZURE_ENTRA_TENANT_ID`, `HDC_AZURE_ENTRA_<APP>_APPLICATION_ID` (Application/client ID — not Secret ID). Optional `HDC_AZURE_ENTRA_<APP>_SECRET_ID` (metadata only).
- **Entra vault:** `HDC_AZURE_ENTRA_<APP>_SECRET_VALUE` (client secret value). Legacy `HDC_AZURE_ENTRA_CLIENT_ID` / `HDC_AZURE_ENTRA_CLIENT_SECRET` still work with a warning.
- **Compute (optional):** `HDC_AZURE_COMPUTE_SUBSCRIPTION_ID`, `HDC_AZURE_COMPUTE_TENANT_ID`, `HDC_AZURE_COMPUTE_CLIENT_ID`, vault `HDC_AZURE_COMPUTE_CLIENT_SECRET`.

See [`docs/manually-deployed/azure.md`](../../../docs/manually-deployed/azure.md).

## Commands

| Verb | Purpose |
|------|---------|
| `query` | Entra discover/diff/import and/or compute status (`--section`, `--import`, `--live`) |
| `deploy` | Create managed Entra apps or provision compute |
| `maintain` | Patch Entra drift or reconcile compute |
| `teardown` | Destroy compute resources only (`--section compute`) |

```bash
node apps/hdc-cli/cli.mjs run infrastructure azure query -- --section all
node apps/hdc-cli/cli.mjs run infrastructure azure query -- --section entra --import --yes
node apps/hdc-cli/cli.mjs run infrastructure azure deploy -- --section entra --dry-run
node apps/hdc-cli/cli.mjs run infrastructure azure deploy -- --section compute --instance a --dry-run
node apps/hdc-cli/cli.mjs run infrastructure azure maintain -- --section entra
```

## Config

- **`entra`:** `graph_base_url`, `automation` (`app_id`), `application_filter`, `applications[]` (prefer `entra/applications/<id>.json` includes).
- **`compute`:** `defaults.azure`, `deployments[]` (prefer `compute/deployments/<id>.json` includes).
- Only Entra entries with `"managed": true` are created/updated. Import preserves `id`/`managed` on match.

## Related

- [AGENTS.md](../../../AGENTS.md)
- [docs/manually-deployed/azure.md](../../../docs/manually-deployed/azure.md)
