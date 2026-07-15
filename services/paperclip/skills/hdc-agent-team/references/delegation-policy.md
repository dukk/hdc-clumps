# Delegation policy summary

## Always autonomous

- `query` and `query --live` via hdc-web-server / hdc-agents fleet
- Read inventory, configs, operation reports
- Write digests to `operations/reports/`
- Enqueue tasks with status `pending`

## Autonomous with notify

- `maintain` without `--prune`, without `--destroy-existing`
- Safe flags: `--no-reboot`, `--skip-resources`, `--skip-clamav-scan`
- `crowdsec maintain --sync-bouncers` when bouncers drift

## Requires operator approval

- `deploy`, `teardown`, `maintain --prune`
- BIND, Cloudflare, nginx-waf production changes
- New public hostnames or TLS certificates
- Any removal of live resources not in config

Full policy: `hdc-private/operations/delegation-policy.md`
