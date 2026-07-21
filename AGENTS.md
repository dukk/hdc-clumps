# HDC packages (hdc-clumps) — agent guide

Automation **plugins** for the Home Data Center. Package scripts live in this repo; the **hdc** CLI orchestrates them from a sibling checkout.

## Role

- Use structured facts from **hdc-private** inventory and clump configs — **do not invent** hostnames, IPs, bridges, VLANs, pool names, or credentials.
- Prefer extending packages under `{clients,infrastructure,services}/` over one-off scripts.
- Only create git commits when the user explicitly asks.

## Sibling repos

| Repo | Role |
| --- | --- |
| **hdc** (`../hdc`) | CLI (`hdc`), `hdc/package/*` shared runtime, schemas, tests |
| **hdc-private** (`../hdc-private`) | Live `config.json`, `.env`, inventory, operation reports |
| **hdc-clumps** (this repo) | Package code, `config.example.json`, manifests |

Open [hdc.code-workspace](hdc.code-workspace) for a multi-root Cursor/VS Code workspace (hdc-clumps + hdc).

## Agent knowledge (OKF)

[`../hdc-private/ai-docs/`](../hdc-private/ai-docs/) is Google Open Knowledge Format for **agent recall** (platform, package, and site). Start at [`../hdc-private/ai-docs/index.md`](../hdc-private/ai-docs/index.md). Human prose stays in `../hdc/docs/`. After learning a durable package fact, update a concept + `log.md` in hdc-private (primary package writer: `hdc-sre-engineer`).

## Invoke hdc (from hdc repo root)

```bash
# Windows (from ../hdc):
hdc.cmd list
hdc.cmd run service pi-hole query --

# Cross-platform:
hdc run infrastructure proxmox query --
```

Set `HDC_CLUMPS_ROOT` to this directory if hdc-clumps is not a sibling. Set `HDC_PRIVATE_ROOT` for hdc-private.

## Package layout

| CLI tier | Directory | Example |
| --- | --- | --- |
| `client` | `clients/` | `run client windows query --` |
| `infrastructure` | `infrastructure/` | `run infrastructure proxmox maintain --` |
| `service` | `services/` | `run service bind deploy --` |

Each package: `manifest.json`, optional `config.json` in **hdc-private** (copy from `config.example.json` here), `deploy/`, `maintain/`, `query/` scripts (`run.mjs`).

Scripts import shared helpers via `hdc/package/*` (resolved from sibling hdc `apps/hdc-cli/lib/package/`).

## Standards (`.cursor/rules/`)

| Rule | Scope |
| --- | --- |
| [hdc-automation.mdc](.cursor/rules/hdc-automation.mdc) | Always-on — CLI, private data, inventory |
| [hdc-inventory-naming.mdc](.cursor/rules/hdc-inventory-naming.mdc) | Always-on — system `id` naming |
| [hdc-automation-logging.mdc](.cursor/rules/hdc-automation-logging.mdc) | Package `*.mjs` — stderr progress, JSON on stdout |
| [proxmox-qemu-guest-agent.mdc](.cursor/rules/proxmox-qemu-guest-agent.mdc) | QEMU deploy paths |
| [proxmox-resource-planning.mdc](.cursor/rules/proxmox-resource-planning.mdc) | Proxmox sizing |
| [hdc-homepage-dashboard.mdc](.cursor/rules/hdc-homepage-dashboard.mdc) | Homepage tiles and widgets |

Skills: [hdc-service-deploy](.cursor/skills/hdc-service-deploy/SKILL.md), [proxmox-resource-planning](.cursor/skills/proxmox-resource-planning/SKILL.md).

## CI and secrets

- **ci** workflow — blocks tracked `config.json`, `.env`, and `10.0.0.x` in public examples
- **secret-scan** — gitleaks on push/PR ([`.gitleaks.toml`](.gitleaks.toml))
- See [docs/manually-deployed/public-repo-policy.md](docs/manually-deployed/public-repo-policy.md)

## Testing

Package unit tests (`*.test.mjs`) run from sibling **hdc** after `npm install`:

```bash
cd ../hdc && npm test
```

## Deeper context

Full CLI reference, inventory schemas, and per-package docs: [hdc AGENTS.md](../hdc/AGENTS.md) and [README.md](README.md). Agent OKF: [`../hdc-private/ai-docs/index.md`](../hdc-private/ai-docs/index.md).
