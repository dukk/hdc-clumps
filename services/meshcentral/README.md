# MeshCentral (`meshcentral`)

Self-hosted [MeshCentral](https://meshcentral.com/) on a privileged Proxmox LXC with Docker Compose (MeshCentral + MongoDB). TLS is offloaded to **nginx-waf**; the CT serves HTTP on port **4430**.

Device management (inventory, power, updates, software, disk) uses the MeshCentral WebSocket API with vault secrets `HDC_MESHCENTRAL_USERNAME` and `HDC_MESHCENTRAL_PASSWORD`. This coexists with WinRM/SSH home client packages — it does not replace them.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` in hdc-private (`clumps/services/meshcentral/config.json`)
- **Inventory:** [`inventory/manual/systems/meshcentral-a.json`](../../../inventory/manual/systems/meshcentral-a.json), [`inventory/manual/services/meshcentral.json`](../../../inventory/manual/services/meshcentral.json)
- **Static IP** on the LXC (`proxmox.lxc.ip_config`)
- **Privileged LXC** (`unprivileged: 0`) with Docker nesting features
- **nginx-waf** site + BIND `meshcentral` CNAME to WAF (see deploy plan)
- **Vault:**
  - `HDC_MESHCENTRAL_MONGO_PASSWORD` (auto-generated on first deploy if missing)
  - `HDC_MESHCENTRAL_USERNAME` / `HDC_MESHCENTRAL_PASSWORD` — MeshCentral account with device rights

## Ports (LAN)

| Protocol | Port | Service |
|----------|------|---------|
| TCP | 4430 | MeshCentral HTTP (behind nginx-waf TLS) |

MongoDB is not published on the host — Docker network only.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision + Docker Compose (`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`) |
| `maintain` | Re-push compose + `.env`, `docker compose pull` + `up -d`; guest Linux baseline **or** device ops (see below) |
| `query` | Config summary; `--live` for CT docker/HTTP + device list via API; `--import --yes` syncs `devices[]` + `inventory/manual/systems` (hardware from online agents; `--skip-hardware` for identity-only) |
| `teardown` | Optional compose down then destroy LXC (`--dry-run`, `--yes`, `--skip-compose-down`) |

### Device ops

```bash
# List agents + CT health
node apps/hdc-cli/cli.mjs run service meshcentral query -- --live

# Import live agents into config devices[] + inventory/manual/systems (with hardware)
node apps/hdc-cli/cli.mjs run service meshcentral query -- --import --yes

# Identity/IP only (no remote hardware collect)
node apps/hdc-cli/cli.mjs run service meshcentral query -- --import --yes --skip-hardware

# Disk for one device
node apps/hdc-cli/cli.mjs run service meshcentral query -- --device lan-1

# Full hardware (CPU/RAM/GPU/disk) for one or more devices
node apps/hdc-cli/cli.mjs run service meshcentral query -- --live --hardware --device lan-1

# Power, updates, software
node apps/hdc-cli/cli.mjs run service meshcentral maintain -- --device lan-1 --power wake
node apps/hdc-cli/cli.mjs run service meshcentral maintain -- --device lan-1 --power off
node apps/hdc-cli/cli.mjs run service meshcentral maintain -- --device lan-1 --updates
node apps/hdc-cli/cli.mjs run service meshcentral maintain -- --device lan-1 --install "Git.Git"
node apps/hdc-cli/cli.mjs run service meshcentral maintain -- --device lan-1 --remove "Git.Git"
node apps/hdc-cli/cli.mjs run service meshcentral maintain -- --device lan-1 --disk --dry-run
```

`--device` accepts hdc `id`, MeshCentral device `name`, or `node_id` (comma-separated or repeated). Mutating ops (except `--power wake`) require an online agent.

## After deploy

1. Run `bind maintain` and `nginx-waf maintain -- --site meshcentral` if not already applied.
2. Open `meshcentral.public_url` and create the first admin account.
3. Store that account in the vault as `HDC_MESHCENTRAL_USERNAME` and `HDC_MESHCENTRAL_PASSWORD`.
4. Install agents using the same public URL.
5. `query --import --yes` to seed `meshcentral.devices[]` and client `inventory/manual/systems/<id>.json` sidecars (CPU/RAM/disk/MAC from online agents). Device ids prefer matches against `clumps/clients/*/config.json` hosts (`id` / IP).

## Related

- Schema: [`apps/hdc-cli/schema/meshcentral.config.schema.json`](../../../apps/hdc-cli/schema/meshcentral.config.schema.json)
- [MeshCentral Docker docs](https://docs.meshcentral.com/install/container/)
- [MeshCtrl](https://docs.meshcentral.com/meshctrl/) (same WebSocket protocol)
