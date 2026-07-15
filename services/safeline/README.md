# SafeLine WAF (HDC package)

[SafeLine](https://github.com/chaitin/SafeLine) community edition on Proxmox LXC with Docker Compose. The **tengine** container uses host networking and listens on **80/443** on the guest — use this as a parallel edge node, not behind nginx-waf.

## Config

Copy `config.example.json` to hdc-private `clumps/services/safeline/config.json`.

| Block | Purpose |
| --- | --- |
| `defaults.proxmox.lxc` | Privileged LXC with Docker (`unprivileged: 0`, `nesting=1`) |
| `defaults.safeline` | Image tag, `region` (`-g` = English international edition; omit/empty = Chinese CE), management port (9443), internal Docker subnet |
| `defaults.sites[]` / `deployments[].sites[]` | Declarative protected apps (Open API sync) |
| `deployments[]` | `system_id`, `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config` |

## Secrets

| Vault key | When |
| --- | --- |
| `HDC_SAFELINE_POSTGRES_PASSWORD` | Auto-generated on first deploy if missing |
| `HDC_SAFELINE_ADMIN_PASSWORD` | Auto-set on deploy when `admin_reset_on_deploy` is true (`resetadmin`); UI login username `admin` |
| `HDC_SAFELINE_API_TOKEN` | Create in SafeLine UI (System Management) before site sync |

## Verbs

```bash
node apps/hdc-cli/cli.mjs run service safeline query --
node apps/hdc-cli/cli.mjs run service safeline deploy -- --instance a
node apps/hdc-cli/cli.mjs run service safeline maintain --
node apps/hdc-cli/cli.mjs run service safeline query -- --live
node apps/hdc-cli/cli.mjs run service safeline teardown -- --instance a --dry-run
```

### Flags

| Flag | Verb | Effect |
| --- | --- | --- |
| `--instance a` | all | Select `safeline-a` |
| `--skip-install` | deploy | Provision LXC only |
| `--skip-existing` / `--redeploy-existing` | deploy | Existing guest policy |
| `--skip-admin-reset` | deploy | Skip `resetadmin` and vault write for admin password |
| `--skip-sites` | deploy, maintain | Skip Open API site sync |
| `--skip-upgrade` | maintain | `compose up` without image pull |
| `--site <id>` | maintain | Sync one site only (no prune side effects elsewhere) |
| `--prune` | maintain | Remove hdc-managed live sites not in config |
| `--skip-clamav` | maintain | Skip ClamAV baseline |

## Site sync

Config `sites[]` entries map to SafeLine `POST/PUT /api/open/site`. HDC marks managed sites with comment prefix `hdc:site:<id>` so `--prune` only removes hdc-owned records.

Example site:

```json
{
  "id": "immich",
  "server_names": ["immich.example.invalid"],
  "ports": ["443"],
  "ssl": true,
  "upstreams": ["http://192.0.2.9:2283"],
  "comment": "Immich via SafeLine edge",
  "load_balance": { "balance_type": 1 }
}
```

## Sizing

Minimum (upstream): 1 vCPU, 1 GiB RAM, 5 GiB disk. Recommended: 2 vCPU, 4 GiB RAM, 32 GiB rootfs.

## Parallel edge

Point public DNS or WAN port-forwards to the SafeLine guest IP for hostnames migrated from nginx-waf. Do not proxy the same hostname through both edges simultaneously.

## Out of scope (v1)

- `configure-only` for existing hosts
- HA (`safeline-b`)
- Automatic TLS cert provisioning (configure in SafeLine UI/API)
