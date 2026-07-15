---
name: hdc-monitor
description: Use when running health sweeps, uptime-kuma or proxmox checks, writing monitor digests, or enqueueing SRE tasks. Do not use for deploy or maintain without approval.
slug: hdc-monitor
---

# HDC monitor skill

Prefer **hdc-agents** fleet schedules / hdc-web-server API auth. Prefer schedule triggers over ad-hoc when a matching schedule exists.

## Monitor schedules (via hdc-web-server)

```http
POST /api/schedules/monitor-uptime-kuma/run
POST /api/schedules/monitor-cluster/run
```

Poll `GET /api/jobs/:id` until complete.

## Ad-hoc queries (when needed)

```json
{"tier":"service","package":"uptime-kuma","verb":"query","args":["--live"]}
```

```json
{"tier":"infrastructure","package":"proxmox","verb":"query"}
```

## Digest format

Post results as a Paperclip issue comment or new issue:

```markdown
# Monitor digest — <timestamp>

## Summary
- Overall: green | yellow | red

## Down / degraded
- <service> — evidence

## Drift
- uptime-kuma: …

## Tasks enqueued
- <task-id>: …
```

## Escalation

- Public outage → assign HDC Manager, mark issue critical
- Internal drift → medium priority SRE task

Only run `uptime-kuma maintain` with Manager approval unless reconciling monitors already in config.
