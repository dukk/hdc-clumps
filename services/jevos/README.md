# jevos (`jevos`)

LAN-only yes/no decision API: [`jev serve`](https://github.com/feder-cr/jev) (MIT) running the
**jevos** OpenVINO INT8 model on CPU (~1–1.4 GB RAM) in a small Proxmox LXC. Modeled on `llama-cpp`'s LXC path.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (`deployments[]`, `mode: proxmox-lxc`)
- **Inventory:** `operations/inventory/systems/virtual/jevos-a.json`
- **Vault:** `HDC_JEVOS_API_KEY` (`server.api_key_vault_key`) — generated and stored on first deploy if missing,
  written to `/etc/jevos/jevos.env` (0600) as `JEV_API_KEY`
- LXC template with glibc ≥ 2.35 (Ubuntu 22.04+)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Create LXC (API) → download `install.binary_asset` + `install.model_asset` from release `install.release` (SHA256SUMS verified) → `jevos.service` |
| `query` | Config summary; `--live` for systemd state + installed release |
| `health` | `GET /health`, unauthenticated POST must be 401, authenticated probe (`--no-auth-probe` to skip) |
| `teardown` | Destroy the LXC (`--dry-run`, `--yes`) |

```bash
hdc run service jevos deploy -- --instance a
hdc run service jevos deploy -- --instance a --redeploy-existing   # reinstall / upgrade release only
hdc run service jevos health
```

## Guest layout

- `/opt/jevos/releases/<tag>/jev/{jev,model/}`, `/opt/jevos/current` → active release
- `jevos.service`: `User=jevos`, `Restart=always`, enabled at boot, `jev serve --host <server.host> --port <server.port>` (default 8017)
- nftables (best effort): port only from `server.allow_cidrs` (default `10.0.0.0/8`)
- `proxmox.lxc.cpuset` (default `0-1`) pins the CT via raw `lxc.cgroup2.cpuset.cpus`: OpenVINO segfaults in an LXC whose CPU affinity (e.g. `7,13`) does not match the 0..n-1 CPU ids lxcfs shows. Keep it starting at 0 and sized to `cores`.
- No port forwards / Cloudflare / WAF records — LAN only.

## API

All calls except `GET /health` need `Authorization: Bearer $JEV_API_KEY`.

```bash
curl -s http://10.0.0.23:8017/v1/systemone \
  -H "Authorization: Bearer $JEV_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"jev-latest","state":"Disk usage on nas-a is 97% and climbing","questions":{"q":{"type":"noul","instructions":"Is this worth alerting a human about?"}}}'
# → answers.q.noul = P(yes)
```
