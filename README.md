# HDC packages (hdc-clumps)

Plugins under `{clients,infrastructure,services}/` automate home data center operations via the hdc CLI. Each package has a `manifest.json`, optional `config.json` (copy from `config.example.json` in hdc-private), and `deploy/`, `maintain/`, `query/`, and sometimes `teardown/` scripts.

**Repo layout:** this tree is consumed by the main [hdc](https://github.com/dukk/hdc) CLI via `hdc clumps init` / `hdc clumps sync` (see `.hdc/clumps-repos.json` in hdc). Clone hdc and hdc-clumps as siblings, or set `HDC_CLUMPS_ROOT` to this directory.

## Agent ownership

This repository is owned by **`hdc-sre-engineer`**: package manifests, deploy/maintain/query scripts, `config.example.json`, and per-package READMEs. The agent implements and repairs package automation but does **not** run production deploy/maintain, edit live config in [**hdc-private**](../hdc-private/README.md), or change the CLI platform in [**hdc**](../hdc/README.md). After scripts are tested, hand off to **`hdc-sre-ops`** for approved production runs. See [multi-agent operations](../hdc/docs/multi-agent-ops.md).

| Repository | Primary agent | Owns |
| --- | --- | --- |
| [**hdc**](../hdc/README.md) | `hdc-engineer` | CLI, schemas, shared runtime, agent fleet, tests |
| **hdc-clumps** (this repo) | `hdc-sre-engineer` | Package scripts, manifests, examples |
| [**hdc-private**](../hdc-private/README.md) | `hdc-sre-ops` | Live `config.json`, inventory, `operations/` |

## Quick reference

```bash
# From hdc repo root (after hdc clumps init):
hdc list
hdc run <tier> <clump> <verb> [-- <args>]
```

| CLI tier | Directory | Example |
|----------|-----------|---------|
| `client` | `clients/` | `run client windows query --` |
| `infrastructure` | `infrastructure/` | `run infrastructure proxmox query --` |
| `service` | `services/` | `run service pi-hole maintain --` |

- **Config:** `services/<id>/config.json` (or matching tier path) in hdc-private — this repo ships `config.example.json` only.
- **Inventory:** `operations/inventory/{systems,services,targets}/` sidecars in hdc-private.
- **Package runtime:** clump scripts import `hdc/package/*` (shared helpers in hdc `apps/hdc-cli/lib/package/`).
- **Details:** per-clump README below; operator reference in [hdc AGENTS.md](../hdc/AGENTS.md) and [AGENTS.md](AGENTS.md).
- **Schemas:** [`apps/hdc-cli/schema/`](../hdc/apps/hdc-cli/schema/) in the hdc repo.

When adding a package, add `manifest.json`, `config.example.json`, a package `README.md`, and a row in the tables below.

## Repo hygiene

- **Policy:** [docs/manually-deployed/public-repo-policy.md](docs/manually-deployed/public-repo-policy.md) — what belongs in this repo vs hdc-private.
- **CI:** GitHub Actions `ci` (blocks tracked `config.json`, `.env`, and `10.0.0.x` in public examples) and `secret-scan` (gitleaks via [`.gitleaks.toml`](.gitleaks.toml)).
- **IDE:** Open [hdc.code-workspace](hdc.code-workspace) for hdc-clumps + sibling hdc; agent rules under [`.cursor/rules/`](.cursor/rules/).
- **Never commit:** live `config.json`, `.env` (except `.env.example`), inventory, operation reports under `**/reports/`.

## Home clients

See also [clients/README.md](clients/README.md) for WinRM bootstrap, Wake-on-LAN, and per-host inventory.

| Package | CLI id | Summary | Config | Access |
|---------|--------|---------|--------|--------|
| [raspberrypi](clients/raspberrypi/README.md) | `raspberrypi` | Home Raspberry Pi OS | [config.example.json](clients/raspberrypi/config.example.json) | SSH to `<host-ip>`; maintain/query only |
| [ubuntu](clients/ubuntu/README.md) | `client-ubuntu` | Home Ubuntu desktops | [config.example.json](clients/ubuntu/config.example.json) | SSH to `<host-ip>`; maintain/query only |
| [windows](clients/windows/README.md) | `windows` | Home Windows clients | [config.example.json](clients/windows/config.example.json) | WinRM `https://<host-ip>:5986` |

## Infrastructure

Shared capabilities: hypervisors, SaaS APIs, NAS, and network controllers. Several packages expose sub-commands via manifest `services[]` (see [proxmox](infrastructure/proxmox/README.md)).

| Package | CLI id | Summary | Config | Access |
|---------|--------|---------|--------|--------|
| [aws](infrastructure/aws/README.md) | `aws` | AWS VPC, EC2, ECS, S3, EBS | [config.example.json](infrastructure/aws/config.example.json) | AWS API; cost estimate before deploy |
| [oci-compute](infrastructure/oci-compute/README.md) | `oci-compute` | Oracle Cloud VCN, VMs, Container Instances | [config.example.json](infrastructure/oci-compute/config.example.json) | OCI API; cost estimate before deploy |
| [azure](infrastructure/azure/README.md) | `azure` | Azure app registrations | [config.example.json](infrastructure/azure/config.example.json) | Microsoft Graph API / Entra portal |
| [cloudflare](infrastructure/cloudflare/README.md) | `cloudflare` | Cloudflare | [config.example.json](infrastructure/cloudflare/config.example.json) | Cloudflare API (DNS, page rules, email routing) |
| [cloudflare-workers](infrastructure/cloudflare-workers/README.md) | `cloudflare-workers` | Cloudflare Workers and Pages | [config.example.json](infrastructure/cloudflare-workers/config.example.json) | Wrangler deploy; Workers routes/secrets and Pages projects |
| [gcp-oauth](infrastructure/gcp-oauth/README.md) | `gcp-oauth` | GCP OAuth (Google Auth Platform) | [config.example.json](infrastructure/gcp-oauth/config.example.json) | Google Cloud Console OAuth credentials |
| [proxmox](infrastructure/proxmox/README.md) | `proxmox` | Proxmox virtualization | [config.example.json](infrastructure/proxmox/config.example.json) | Proxmox UI `https://<hypervisor>:8006`; LXC/QEMU deploy, cluster query |
| [smtp2go](infrastructure/smtp2go/README.md) | `smtp2go` | SMTP2GO | [config.example.json](infrastructure/smtp2go/config.example.json) | SMTP2GO REST API; outbound mail via postfix-relay |
| [synology-nas](infrastructure/synology-nas/README.md) | `synology-nas` | Synology NAS | [config.example.json](infrastructure/synology-nas/config.example.json) | DSM `https://<nas-ip>:5001`; SSH for automation |
| [twilio](infrastructure/twilio/README.md) | `twilio` | Twilio | [config.example.json](infrastructure/twilio/config.example.json) | Twilio REST API (SIP trunks, phone numbers) |
| [uptimerobot](infrastructure/uptimerobot/README.md) | `uptimerobot` | UptimeRobot | [config.example.json](infrastructure/uptimerobot/config.example.json) | UptimeRobot API v2 (monitors, status pages, alert contacts) |
| [ubuntu](infrastructure/ubuntu/README.md) | `ubuntu` | Ubuntu server | [config.example.json](infrastructure/ubuntu/config.example.json) | SSH to bootstrap hosts; Docker deploy over SSH |
| [unifi-network](infrastructure/unifi-network/README.md) | `unifi-network` | UniFi Network | [config.example.json](infrastructure/unifi-network/config.example.json) | UniFi controller API (sites, port forwards) |

## Services

Applications and workloads on Proxmox guests, Synology, or configure-only SSH targets.

| Package | CLI id | Summary | Config | Access |
|---------|--------|---------|--------|--------|
| [asterisk](services/asterisk/README.md) | `asterisk` | Asterisk PBX (PJSIP) | [config.example.json](services/asterisk/config.example.json) | SIP `:5060`; RTP `10000–20000` on `<guest-ip>` |
| [audiobookshelf](services/audiobookshelf/README.md) | `audiobookshelf` | Audiobookshelf | [config.example.json](services/audiobookshelf/config.example.json) | `http://<guest-ip>:13378` or HTTPS via nginx-waf |
| [bind](services/bind/README.md) | `bind` | BIND DNS | [config.example.json](services/bind/config.example.json) | DNS UDP/TCP `:53` on `<guest-ip>` |
| [cassandra](services/cassandra/README.md) | `cassandra` | Apache Cassandra cluster | [config.example.json](services/cassandra/config.example.json) | CQL `:9042` on `<node-ip>` |
| [crowdsec](services/crowdsec/README.md) | `crowdsec` | CrowdSec LAPI and bouncers | [config.example.json](services/crowdsec/config.example.json) | LAPI `http://<guest-ip>:8080` |
| [draw-io](services/draw-io/README.md) | `draw-io` | draw.io (diagrams.net) | [config.example.json](services/draw-io/config.example.json) | `http://<guest-ip>:8080` or HTTPS via nginx-waf |
| [gatus](services/gatus/README.md) | `gatus` | Gatus health dashboard | [config.example.json](services/gatus/config.example.json) | `http://<guest-ip>:8080` |
| [gitlab](services/gitlab/README.md) | `gitlab` | GitLab CE | [config.example.json](services/gitlab/config.example.json) | `http://<guest-ip>:80` or HTTPS; Git SSH `:2222` |
| [hdc-agents](services/hdc-agents/README.md) | `hdc-agents` | HDC agent fleet + scheduler (replaces hdc-runner); Tasks UI via hdc-web-server `:9120` | [config.example.json](services/hdc-agents/config.example.json) | Agent A2A `:9200–9207`; web UI `:9120` |
| [homeassistant](services/homeassistant/README.md) | `homeassistant` | Home Assistant | [config.example.json](services/homeassistant/config.example.json) | `http://<guest-ip>:8123` or HTTPS via nginx-waf |
| [homepage](services/homepage/README.md) | `homepage` | Homepage (gethomepage.dev) | [config.example.json](services/homepage/config.example.json) | `http://<guest-ip>:3000` or HTTPS (often internal-only) |
| [immich](services/immich/README.md) | `immich` | Immich photo library | [config.example.json](services/immich/config.example.json) | `http://<guest-ip>:2283` or HTTPS via nginx-waf |
| [jenkins](services/jenkins/README.md) | `jenkins` | Jenkins | optional `config.json` | `http://<guest-ip>:8080` (stub deploy) |
| [kafka](services/kafka/README.md) | `kafka` | Apache Kafka KRaft cluster | [config.example.json](services/kafka/config.example.json) | Kafka brokers on `<node-ip>` (no web UI) |
| [keycloak](services/keycloak/README.md) | `keycloak` | Keycloak IAM | [config.example.json](services/keycloak/config.example.json) | `http://<guest-ip>:8080` or HTTPS |
| [listmonk](services/listmonk/README.md) | `listmonk` | Listmonk newsletter manager | [config.example.json](services/listmonk/config.example.json) | `http://<guest-ip>:9000` or HTTPS via nginx-waf |
| [llama-cpp](services/llama-cpp/README.md) | `llama-cpp` | Llama.cpp llama-server | [config.example.json](services/llama-cpp/config.example.json) | `http://<guest-ip>:8080` (OpenAI-compatible API) |
| [lms](services/lms/README.md) | `lms` | LM Studio (llmster) headless | [config.example.json](services/lms/config.example.json) | `http://<guest-ip>:1234` (OpenAI-compatible API) |
| [mailcow](services/mailcow/README.md) | `mailcow` | Mailcow mail server stack | [config.example.json](services/mailcow/config.example.json) | `https://<mailcow-hostname>` admin; SMTP/IMAP mail ports |
| [minecraft](services/minecraft/README.md) | `minecraft` | Minecraft server | optional `config.json` | Minecraft Java `:25565` on `<guest-ip>` (stub deploy) |
| [n8n](services/n8n/README.md) | `n8n` | n8n workflow automation | [config.example.json](services/n8n/config.example.json) | `http://<guest-ip>:5678` or HTTPS via nginx-waf |
| [nagios](services/nagios/README.md) | `nagios` | Nagios monitoring | [config.example.json](services/nagios/config.example.json) | `http://<guest-ip>/nagios4` |
| [nextcloud](services/nextcloud/README.md) | `nextcloud` | Nextcloud All-in-One | [config.example.json](services/nextcloud/config.example.json) | `https://<guest-ip>:8080` (AIO wizard; use IP not domain) |
| [nginx](services/nginx/README.md) | `nginx` | Nginx web reverse proxy | [config.example.json](services/nginx/config.example.json) | `https://<hostname-from-sites[]>` per published site |
| [nginx-waf](services/nginx-waf/README.md) | `nginx-waf` | Nginx WAF reverse proxy | [config.example.json](services/nginx-waf/config.example.json) | `https://<server-name-from-sites[]>` per published site |
| [ollama](services/ollama/README.md) | `ollama` | Ollama LLM runtime | [config.example.json](services/ollama/config.example.json) | `http://<guest-ip>:11434` (Ollama API) |
| [open-webui](services/open-webui/README.md) | `open-webui` | Open WebUI (Ollama chat) | [config.example.json](services/open-webui/config.example.json) | `http://<guest-ip>:3000` |
| [greenbone](services/greenbone/README.md) | `greenbone` | Greenbone Community Edition | [config.example.json](services/greenbone/config.example.json) | `http://<guest-ip>:3000` (Greenbone admin UI) |
| [pi-hole](services/pi-hole/README.md) | `pi-hole` | Pi-hole DNS filtering | [config.example.json](services/pi-hole/config.example.json) | `http://<guest-ip>/admin`; DNS `:53` |
| [plex](services/plex/README.md) | `plex` | Plex Media Server (Synology) | [config.example.json](services/plex/config.example.json) | `http://<nas-ip>:32400/web` |
| [postfix-relay](services/postfix-relay/README.md) | `postfix-relay` | Postfix SMTP relay | [config.example.json](services/postfix-relay/config.example.json) | `smtp://<guest-ip>:25` (LAN relay) |
| [postgresql](services/postgresql/README.md) | `postgresql` | PostgreSQL database server | [config.example.json](services/postgresql/config.example.json) | `:5432` on `<guest-ip>` |
| [postiz](services/postiz/README.md) | `postiz` | Postiz social scheduling | [config.example.json](services/postiz/config.example.json) | `http://<guest-ip>:80` or HTTPS |
| [redis](services/redis/README.md) | `redis` | Redis Cluster | [config.example.json](services/redis/config.example.json) | `:6379` on `<node-ip>` (cluster clients) |
| [scanopy](services/scanopy/README.md) | `scanopy` | Scanopy network discovery | [config.example.json](services/scanopy/config.example.json) | `http://<guest-ip>:60072` |
| [searxng](services/searxng/README.md) | `searxng` | SearXNG metasearch | [config.example.json](services/searxng/config.example.json) | `http://<guest-ip>:8080` (LAN) |
| [solidtime](services/solidtime/README.md) | `solidtime` | SolidTime time tracking | [config.example.json](services/solidtime/config.example.json) | `https://<guest-ip>` or `solidtime.app_url` |
| [splunk](services/splunk/README.md) | `splunk` | Splunk Free (standalone) | [config.example.json](services/splunk/config.example.json) | `https://<guest-ip>:8000` (Splunk Web) |
| [step-ca](services/step-ca/README.md) | `step-ca` | Smallstep step-ca | [config.example.json](services/step-ca/config.example.json) | HTTPS `:443`; ACME `https://<ca-host>/acme/acme/directory` |
| [trivy](services/trivy/README.md) | `trivy` | Trivy scanner node | [config.example.json](services/trivy/config.example.json) | SSH scan runner (no web UI) |
| [unleash](services/unleash/README.md) | `unleash` | Unleash feature flags | [config.example.json](services/unleash/config.example.json) | `http://<guest-ip>:4242` or HTTPS via nginx-waf |
| [uptime-kuma](services/uptime-kuma/README.md) | `uptime-kuma` | Uptime Kuma monitoring | [config.example.json](services/uptime-kuma/config.example.json) | `http://<guest-ip>:3001` |
| [valkey](services/valkey/README.md) | `valkey` | Valkey Cluster | [config.example.json](services/valkey/config.example.json) | `:6379` on `<node-ip>` (cluster clients) |
| [vaultwarden](services/vaultwarden/README.md) | `vaultwarden` | Vaultwarden password manager | [config.example.json](services/vaultwarden/config.example.json) | `https://<domain-from-config>` via nginx-waf; `/admin` |
| [wazuh](services/wazuh/README.md) | `wazuh` | Wazuh single-node stack | [config.example.json](services/wazuh/config.example.json) | `https://<guest-ip>:443` (Wazuh dashboard) |
| [windows-desktop](services/windows-desktop/README.md) | `windows-desktop` | Windows 11 desktop (QEMU) | [config.example.json](services/windows-desktop/config.example.json) | RDP/desktop on `<guest-ip>` |
| [wireguard](services/wireguard/README.md) | `wireguard` | WireGuard VPN hub | [config.example.json](services/wireguard/config.example.json) | UDP `:51820` on `<guest-ip>` |
| [yacy](services/yacy/README.md) | `yacy` | YaCy decentralized search | [config.example.json](services/yacy/config.example.json) | `http://<guest-ip>:8090` |

## Related

- [AGENTS.md](../AGENTS.md) — operator reference for every package
- [clients/README.md](clients/README.md) — home workstation clients
- [docs/manually-deployed/](../docs/manually-deployed/) — gear hdc does not manage end-to-end
