---
name: hdc-sre
description: Use when executing approved maintain or deploy work via hdc-web-server / the hdc-agents fleet, fixing monitor findings, or applying safe package upgrades. Do not use without explicit approval on the Paperclip issue for destructive verbs.
slug: hdc-sre
---

# HDC SRE skill

## Before acting

1. Read the assigned Paperclip issue — confirm operator approval for deploy, teardown, or `--prune`
2. Load **hdc-agent-team** skill for delegation rules
3. Use **hdc-web-server** API (on hdc-agents-a `:9120`) or the agent fleet for CLI jobs

## Safe autonomous maintain (via hdc-web-server)

POST `/api/jobs` with safe args:

```json
{
  "tier": "service",
  "package": "nginx-waf",
  "verb": "maintain",
  "args": ["--group", "public", "--no-reboot", "--skip-resources", "--skip-clamav-scan", "--sync-certs"]
}
```

```json
{
  "tier": "service",
  "package": "bind",
  "verb": "maintain",
  "args": ["--no-reboot", "--skip-resources"]
}
```

## Requires approval on issue

- `deploy`, `teardown`
- `maintain --prune`, `maintain --destroy-existing`
- BIND zone changes, nginx-waf new sites, Cloudflare DNS

## After work

1. Post job log excerpt to Paperclip issue comment
2. Mark issue done with outcome summary
3. Reference operation report path from job stderr if present

## Greenfield deploys

Write `plan.md` in hdc-private, wait for operator approval before any deploy verb.
