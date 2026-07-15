# A2A Registry (`a2a-registry`)

> **Status:** Deprecated — agent discovery moved to **LiteLLM** (`litellm.a2a_agents[]`).
> Do not deploy this clump for new work. See [docs/multi-agent-ops.md](../../../docs/multi-agent-ops.md).

[allenday/a2a-registry](https://github.com/allenday/a2a-registry) (PyPI `a2a-registry`) — legacy in-memory A2A Protocol registry. Package scripts retained for optional restore.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`, and optional `a2a_registry.public_url` for future nginx-waf
- **Inventory:** `inventory/manual/systems/a2a-registry-a.json`; `inventory/manual/services/a2a-registry.json`
- **Vault:** none required for v1

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker build/run A2A Registry (`a2a_registry.pypi_version`) |
| `maintain` | Re-push Dockerfile + compose; `docker compose build` + `up -d`; guest Linux baseline |
| `query` | Config summary; `--live` for HTTP probe on `/health` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service a2a-registry deploy -- --instance a
node apps/hdc-cli/cli.mjs run service a2a-registry query -- --live
node apps/hdc-cli/cli.mjs run service a2a-registry maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain; skips image rebuild), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.141:8000`).
2. **Inventory:** set `access.nodes[0].ip` on `a2a-registry-a.json`.
3. **Health:** `GET /health`; OpenAPI docs often at `/docs`.
4. **HTTPS (optional):** set `a2a_registry.public_url`, add BIND + nginx-waf upstream manually.

## Related

- [AGENTS.md — A2A Registry](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/a2a-registry.config.schema.json`](../../../apps/hdc-cli/schema/a2a-registry.config.schema.json)
- Upstream docs: [a2a-registry.dev](https://a2a-registry.dev/documentation/)
