# AWS infrastructure (HDC package)

Declarative VPC, EC2, ECS Fargate, S3, and EBS lifecycle with **pre-deploy cost estimates** and operator confirmation.

## Config

Copy [`config.example.json`](config.example.json) to hdc-private as `clumps/infrastructure/aws/config.json`.

## Auth

- `.env`: `HDC_AWS_ACCESS_KEY_ID`
- Vault: `HDC_AWS_SECRET_ACCESS_KEY` (required); optional `HDC_AWS_SESSION_TOKEN`

```bash
hdc secrets set HDC_AWS_SECRET_ACCESS_KEY
```

## Commands

```bash
hdc run infrastructure aws query --
hdc run infrastructure aws deploy -- --dry-run
hdc run infrastructure aws deploy -- --yes
hdc run infrastructure aws maintain --
hdc run infrastructure aws teardown -- --resource vm-example-a --yes
```

Deploy and maintain that **create** billable resources:

1. Build a plan from config vs live state
2. Fetch monthly cost estimates (AWS Price List API)
3. Print breakdown on stderr and prompt `[y/N]` unless `--yes` or `--dry-run`
4. Write cost details to the operation report

Flags: `--resource <id>`, `--dry-run`, `--yes`, `--skip-cost-confirm`, `--prune` (maintain), `--all` (teardown).

## Operator doc

See [`docs/manually-deployed/aws.md`](../../../docs/manually-deployed/aws.md) for IAM policy guidance and cost caveats.
