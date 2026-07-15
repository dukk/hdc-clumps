---
name: hdc-agent-team
description: Use when coordinating HDC homelab work across agents — task files, delegation policy, escalation, and role boundaries. Do not use for executing hdc CLI directly without hdc-web-server / agent fleet access.
slug: hdc-agent-team
---

# HDC agent team conventions

## Paths (hdc-private on hdc-agents guest)

| Path | Purpose |
|------|---------|
| `operations/tasks/<id>.md` | Work queue (one task per file) |
| `operations/task-report.md` | Manager-maintained status summary |
| `operations/delegation-policy.md` | Approval rules |
| `operations/ip-allocations.md` | IP groups and next-free addresses |
| `operations/reports/` | Monitor, security, research digests |

Task state is **guest-authoritative** on hdc-agents. Use hdc-web-server Tasks UI (`:9120`) or A2A for approvals.

## Task file schema

See `apps/hdc-agent-server/skills/hdc-agent-team/SKILL.md` in the hdc repo for frontmatter fields.

Status: `pending` | `approved` | `in_progress` | `blocked` | `done`

Priority: `critical` | `high` | `medium` | `low`

## Paperclip agent roles

| Agent | May execute | Must not |
|-------|-------------|----------|
| HDC Manager | Prioritize, assign, notify | deploy/prune without approval |
| HDC Monitor | Health queries via hdc-web / fleet, digests | Change service configs |
| HDC SRE | Approved maintains/deploys | Skip approval for destructive verbs |
| HDC Security | Security queries, crowdsec bouncer sync | Ad-hoc firewall edits |

## Rules

- Never invent hostnames, IPs, or credentials — use inventory via hdc-web-server API
- Secrets: env var names only; values in vault
- Destructive work requires Paperclip issue explicitly approved by operator

## Escalation

| Condition | Action |
|-----------|--------|
| Public service down > 15 min | Manager + Discord |
| Security incident | Immediate Discord |
| Routine monitor drift | Paperclip issue + comment |

See `references/delegation-policy.md` for full policy text.
