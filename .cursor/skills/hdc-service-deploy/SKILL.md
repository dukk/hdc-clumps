---
name: hdc-service-deploy
description: >-
  Configures and deploys HDC service packages via the hdc CLI: interactive
  discovery (IP, Proxmox node, VM vs LXC vs Synology), writes plan.md for
  approval, runs deploy with script fixes on failure, and optional dependency
  packages (bind, nginx-waf, cloudflare, synology-nas). Use when deploying a
  service, scaffolding a new package, fixing a deploy script, or wiring reverse
  proxy and DNS for an app.
disable-model-invocation: true
---

# HDC service deploy

End-to-end workflow for **configure → plan → approve → deploy → validate**, with optional infrastructure dependencies. Pair with [proxmox-resource-planning](../proxmox-resource-planning/SKILL.md) (sizing).

## Hard rules

1. **Never invent** hostnames, IPs, bridges, VLANs, vmids, or credentials — use `hdc-private/operations/ip-allocations.md`, inventory, hdc-private config, BIND zones, or ask the user.
2. **Write `plan.md` and wait for explicit approval** before any `deploy` / `maintain` that changes infrastructure or live DNS/proxy config.
3. **Dependencies are opt-in** — list them in the plan; run only what the user approved ([dependencies.md](dependencies.md)).
4. **Secrets:** vault key **names** only in plans and chat; use `readLineQuestion(..., { mask: true })` when prompting; never log values.
5. **Logging:** package progress on **stderr**; keep **stdout** clean for JSON ([hdc-automation-logging](../../../.cursor/rules/hdc-automation-logging.mdc)).
6. **No root scratch scripts:** never write `tmp-*` at repo roots — fix/extend package scripts in hdc-clumps ([hdc-automation](../../../.cursor/rules/hdc-automation.mdc)).

## Entry points

Run from **sibling hdc** repo root (`../hdc`):

```bash
hdc list
hdc run service <id> query --
hdc run service <id> deploy -- [--instance a] [flags]
```

Windows: `hdc.cmd` from hdc root. Config and inventory live in **hdc-private** when present (`HDC_PRIVATE_ROOT` or `../hdc-private`). Package code lives in **hdc-clumps** (this repo or `HDC_CLUMPS_ROOT`).

---

## Phase 0 — Classify work

| Situation | Action |
|-----------|--------|
| Package exists under `services/<id>/` (or `infrastructure/`, `clients/`) | Deploy or re-deploy existing service |
| No package yet | New package — plan must include scaffolding (see [New package](#new-package-scaffolding)) |
| `configure-only` in config | Guest already exists; plan SSH/configure steps only (nginx, nginx-waf) |

Identify: `manifest.json`, hdc `AGENTS.md` section, `config.example.json`, `../hdc/apps/hdc-cli/schema/<id>.config.schema.json`.

---

## Phase 1 — Discovery questions

Use **AskQuestion** when available; otherwise ask in chat. Batch into **1–2 rounds**. Skip questions already answered in inventory or hdc-private config.

### Required (if missing)

| Topic | Guidance |
|-------|----------|
| **Service id** | Manifest id (e.g. `searxng`, `vaultwarden`) or new slug |
| **Deploy backend** | `proxmox-lxc`, `proxmox-qemu`, `proxmox-qemu-haos`, `proxmox-qemu-iso`, `synology-docker`, `configure-only` |
| **Proxmox node** | `proxmox.host_id` / inventory `hosted_on_system_id` (e.g. `hypervisor-a`) |
| **Static IP** | CIDR + gateway; read `hdc-private/operations/ip-allocations.md` — pick the matching IP group and **Next free** address; cross-check BIND (`services/bind/config.json` in hdc-private) and inventory |
| **Instance letter** | `-a`, `-b` — [hdc-inventory-naming](../../../.cursor/rules/hdc-inventory-naming.mdc) |
| **Public HTTPS?** | LAN-only vs `https://` hostname — drives dependency section |

### Conditional

- **VM vs LXC** — if unsure on Proxmox: LXC = less overhead; VM = isolation, Windows, GPU/USB, QEMU guest agent. Read **proxmox-resource-planning** for CPU/RAM/disk.
- **GPU / USB / privileged Docker** — flag early (ollama, homeassistant, Docker-in-LXC).
- **Secrets** — from `manifest.json` `env_required`; confirm `secrets set` before deploy.
- **Dependencies** — present checklist from [dependencies.md](dependencies.md); **default off**.

---

## Phase 2 — Read-only research

Before writing the plan:

1. Read `hdc-private/operations/ip-allocations.md` — classify workload IP group and note **Next free** candidate.
2. Read `services/<id>/` in hdc-clumps (manifest, example config, README).
3. Read hdc-private overrides: `services/<id>/config.json`, `operations/inventory/systems/<system-id>.json`, `operations/inventory/services/<id>.json`.
4. `hdc run service <id> query --` (add `--live` if safe and useful).
5. Proxmox capacity unknown → **proxmox-resource-planning** or `run infrastructure proxmox query --`.

Do **not** run `deploy` in this phase.

---

## Phase 3 — Write `plan.md` (approval gate)

**Default path:** `hdc-private/services/<service-id>/plan.md`

1. Copy structure from [plan-template.md](plan-template.md); replace `{{placeholders}}`.
2. Include copy-paste **CLI sequence**, file paths, vault key names, rollback/teardown commands.
3. Section **7 (Dependencies)** — unchecked boxes until user confirms.
4. Section **10 (Approval)** — must be satisfied before Phase 4.

**Present the plan** to the user (summary + path). **Stop.** Cursor Plan tool approval counts as explicit approval; still write `plan.md` as the durable record.

---

## Phase 4 — Prepare (after approval only)

1. Ensure hdc-private `config.json` exists (`config.example.json` → copy, or `node ../hdc/apps/hdc-cli/scripts/bootstrap-hdc-private-configs.mjs`).
2. Create/update inventory sidecars in hdc-private (`kind: system`, `kind: services`) — id matches filename; naming rules enforced.
3. `hdc secrets set <KEY>` for each required secret (masked).
4. Validate JSON against `../hdc/apps/hdc-cli/schema/*.schema.json`.

---

## Phase 5 — Deploy and fix loop

```bash
hdc run service <id> deploy -- [--instance a] [package flags]
```

**On success:** note IP, ports, and report path on stderr (`hdc-private/services/<id>/reports/deploy-*.md`). Update `hdc-private/operations/ip-allocations.md` assignment row for the new static IP.

**On failure:**

1. Read stderr + latest deploy report.
2. Classify: config / inventory typo | Proxmox conflict (vmid, IP) | missing vault | script bug.
3. Fix with **minimal scope** — prefer hdc-private config and inventory; edit hdc-clumps `**/*.mjs` only when the script is wrong.
4. Retry with same flags; use package flags (`--skip-existing`, `--redeploy-existing`, `--skip-install`) per README.
5. If `../hdc/apps/hdc-cli/` changed: `cd ../hdc && npm run test`.

**QEMU:** `agent=1` + in-guest `qemu-guest-agent` per [proxmox-qemu-guest-agent](../../../.cursor/rules/proxmox-qemu-guest-agent.mdc).

---

## Phase 6 — Dependencies (approved items only)

Follow order in [dependencies.md](dependencies.md). Example after guest is up:

```bash
hdc run service bind maintain --
hdc run service nginx-waf maintain -- --site <site-id>
hdc run infrastructure cloudflare maintain -- --zone <zone>
```

Use upstream from deploy output (e.g. `http://<ct-ip>:5678`). For nginx-waf behind Cloudflare, set `client_ip: cloudflare` on the site when appropriate.

If the user approved only deploy in section 10, **skip this phase** and remind them what remains.

---

## Phase 7 — Validate and close

```bash
hdc run service <id> query -- --live
```

- Update hdc-private `operations/inventory/systems/<system-id>.json` — `access.nodes[].ip`, `web_ui`.
- Summarize: IP, URL, report path, `manifest.json` `operation_report.next_steps`.
- Do not commit unless the user asks.

---

## New package scaffolding

When no `services/<id>/` exists in hdc-clumps, the plan must include:

| Artifact | Notes |
|----------|--------|
| `manifest.json` | `id`, `verbs`, `env_required`, `inventory_docs`, `operation_report.next_steps` |
| `config.example.json` + schema | `../hdc/apps/hdc-cli/schema/<id>.config.schema.json` |
| `deploy/maintain/query/run.mjs` (+ `teardown` if destructive) | Match logging rules |
| `lib/` | deployments resolver, install helpers |
| README | Prerequisites, flags, after-deploy |

**Reference clones:**

| Pattern | Clone from |
|---------|------------|
| Docker on Proxmox LXC | `searxng`, `yacy`, `scanopy` |
| QEMU + SSH install | `postgresql`, `step-ca`, `splunk` |
| Synology Docker | `immich` (`synology-docker` deployment) |
| Multi-mode | `immich`, `ollama` |

---

## Related

- [plan-template.md](plan-template.md) — plan skeleton
- [dependencies.md](dependencies.md) — dependency matrix and order
- [proxmox-resource-planning](../proxmox-resource-planning/SKILL.md) — sizing
- [.cursor/rules/hdc-automation.mdc](../../../.cursor/rules/hdc-automation.mdc) — inventory and private repo
