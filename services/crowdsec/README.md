# CrowdSec (`crowdsec`)

CrowdSec Local API (LAPI) on Proxmox LXC with Hub collections, UniFi syslog ingestion, firewall bouncers on `vm-nginx-waf-*`, and optional UniFi address-group sync.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private)
- **Inventory:** [`inventory/manual/systems/crowdsec-a.json`](../../../inventory/manual/systems/crowdsec-a.json); [`inventory/manual/services/crowdsec.json`](../../../inventory/manual/services/crowdsec.json)
- **Proxmox:** `provision.guest_agents.crowdsec` with `lapi_url`, optional `collections[]` / `collections_by_service`
- **Vault:** `HDC_CROWDSEC_ENROLL_KEY` (auto-minted on deploy/maintain if missing)
- **UniFi API sync:** `HDC_UNIFI_NETWORK_API_KEY` in vault (shared with `unifi-network` package)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision + LAPI + collections + UniFi rsyslog (when enabled) |
| `maintain` | Re-apply LAPI, hub/collections, UniFi syslog; `--sync-bouncers` for firewall + UniFi API bouncers |
| `query` | Config summary; `--live` for collections, syslog, decisions, bouncers |
| `teardown` | Destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service crowdsec deploy --
node apps/hdc-cli/cli.mjs run service crowdsec maintain --
node apps/hdc-cli/cli.mjs run service crowdsec maintain -- --sync-bouncers
node apps/hdc-cli/cli.mjs run service crowdsec query -- --live
```

### Maintain flags

| Flag | Effect |
|------|--------|
| `--sync-bouncers` | Sync firewall bouncers to nginx-waf nodes and UniFi `crowdsec-block` group |
| `--skip-upgrade` | Skip apt upgrade and `cscli hub update` |
| `--skip-collections` | Skip `cscli collections install` |

## UniFi remote logging (manual)

On the UDM: **Settings → System → Remote Logging**

- Server: CrowdSec LAPI CT IP (e.g. `10.0.0.201`)
- Port: `4242` (or `crowdsec.unifi.syslog.listen_port`)
- Enable **Security Events** and **Admin Events** (CEF when offered)

## UniFi WAN block rule (manual)

Create a **WAN IN Drop** policy above allow rules with source address group **`crowdsec-block`** (or your configured `group_name`). HDC syncs LAPI ban decisions into that group; it does not create the firewall policy.

## Native UDM bouncer (optional)

See [`docs/manually-deployed/crowdsec-unifi-bouncer.md`](../../../docs/manually-deployed/crowdsec-unifi-bouncer.md). Disable the HDC API UniFi bouncer (`enabled: false` on the `type: unifi` entry) when using the native gateway bouncer to avoid duplicate enforcement.

## Related

- [AGENTS.md — CrowdSec](../../../AGENTS.md)
- [CrowdSec UniFi collection](https://app.crowdsec.net/hub/author/crowdsecurity/collections/unifi)
- Schema: [`apps/hdc-cli/schema/crowdsec.config.schema.json`](../../../apps/hdc-cli/schema/crowdsec.config.schema.json)
