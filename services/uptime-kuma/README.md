# Uptime Kuma (`uptime-kuma`)

Deploy Uptime Kuma on Proxmox LXC or Oracle Cloud VM (Node 22, systemd, port 3001), upgrade releases, probe health, and reconcile monitors and notifications (Discord + SMTP) from config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (schema v5: per-deployment `monitors[]`, `notifications[]`, `uptime_kuma_auth`)
- **Inventory:** `uptime-kuma-a` (Proxmox); optional `uptime-kuma-ext-a` (OCI); service [`inventory/manual/services/uptime-kuma.json`](../../../inventory/manual/services/uptime-kuma.json)
- **Auth:** per-deployment `HDC_UPTIME_KUMA_USERNAME` / vault password (e.g. `HDC_UPTIME_KUMA_PASSWORD`, `HDC_UPTIME_KUMA_PASSWORD_EXT_A`). API keys are read-only upstream.

## Two-instance pattern

| Instance | Mode | Monitors | Alerts |
|----------|------|----------|--------|
| `uptime-kuma-a` | `proxmox-lxc` | Root `monitors/` (LAN + infra) | Manual / email |
| `uptime-kuma-ext-a` | `oci-vm` | `monitors-public/` (HTTPS edge) | Discord `#hdc-ops` via `notifications[]` |

OCI UK API is reached over SSH (`api_via_ssh: true`) by default. Optional `oci.admin_ingress` opens the admin port on the OCI VM guest iptables (and must match a restricted NSG rule in [`oci-compute`](../../infrastructure/oci-compute/)).

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC or OCI VM + install from GitHub release tarball |
| `maintain` | Upgrade/restart guest + sync `notifications[]` and `monitors[]` per deployment |
| `query` | Guest health + monitor drift; import from homepage or live API |
| `teardown` | Destroy LXC or OCI VM |

```bash
hdc run service uptime-kuma deploy -- --instance a
hdc run service uptime-kuma deploy -- --instance ext-a
hdc run service uptime-kuma maintain -- --instance ext-a
hdc run service uptime-kuma query -- --live
```

## Monitor bootstrap

1. Seed `monitors[]` from homepage dashboard targets:

   ```bash
   hdc run service uptime-kuma query -- --import-from-homepage --yes
   ```

2. Review/edit monitors in hdc-private `config.json` (`managed: true` on hdc-owned entries). Use `$hdc.include` for split files under `monitors/` or `monitors-public/`.

3. Apply to live Uptime Kuma:

   ```bash
   hdc run service uptime-kuma maintain -- --dry-run
   hdc run service uptime-kuma maintain -- --instance ext-a
   ```

## Notifications (Discord + SMTP)

Add to config (root or per-deployment). Two managed types: `discord` (webhook from
vault) and `smtp` (email — the second alert path when Discord is down):

```json
"notifications": [
  {
    "id": "hdc-ops-discord",
    "name": "HDC Ops Discord",
    "type": "discord",
    "managed": true,
    "discord_webhook_vault_key": "HDC_OPS_DISCORD_WEBHOOK_URL",
    "discord_username": "Uptime Kuma",
    "apply_to_monitors": true
  },
  {
    "id": "hdc-ops-mail",
    "name": "HDC Ops Mail",
    "type": "smtp",
    "managed": true,
    "use_mail_relay": true,
    "mail_to": "ops@example.invalid",
    "custom_subject": "[Uptime Kuma] {{name}} is {{status}}",
    "apply_to_monitors": true
  }
]
```

**SMTP fields:** `use_mail_relay: true` fills `smtp_host`/`smtp_port`/`mail_from` from
postfix-relay `client_defaults` (LAN instance; no auth). For the external OCI instance
the relay is unreachable — set explicit `smtp_host`/`smtp_port` (e.g. SMTP2GO) plus
`smtp_username_env` (env var name) and `smtp_password_vault_key` (vault key), and
override `notifications` on that deployment. Optional: `smtp_secure`,
`smtp_ignore_tls_error`, `mail_cc`, `mail_bcc`, `mail_from`.

`maintain` syncs notifications before monitors. Use `--skip-notifications` to skip.

## OCI deploy (`oci-vm`)

1. Configure [`oci-compute`](../../infrastructure/oci-compute/) (VCN, NSG with TCP 22/80/443, optional restricted TCP 3001, instance `uptime-kuma-ext-a`).
2. `hdc run infrastructure oci-compute deploy -- --resource uptime-kuma-ext-a --yes`
3. Set `deployments[].configure.ssh.host` to the public IP; set `uptime_kuma.public_url` to `https://status-ext.dukk.org` (or your public hostname); deploy UK: `--instance ext-a`
4. **Admin UI:** SSH tunnel (`ssh -L 3001:127.0.0.1:3001 ubuntu@<public-ip>`) or direct HTTP on `:3001` when `oci.admin_ingress.allowed_cidrs[]` matches your home public CIDR and the OCI NSG allows the same source.
5. **Status page:** https://status-ext.dukk.org/status/public-edge (Caddy TLS on the VM when `public_url` is HTTPS). `oci-compute maintain` mirrors NSG TCP ingress (port + source CIDR) onto the subnet security list; Caddy deploy/maintain also opens 80/443 (and optional admin port/CIDR) in the OCI Ubuntu guest iptables rules (image default allows SSH only).
6. First-run admin via SSH tunnel; then `maintain --instance ext-a` to sync public monitors + Discord.

See hdc-private `clumps/services/uptime-kuma/plan.md` for Console setup and rollback.

## Common flags

`--instance a|ext-a`, `--system-id uptime-kuma-ext-a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade`, `--skip-monitors`, `--skip-notifications`, `--prune`, `--dry-run`, `--monitor <id>`, `--yes` (teardown/import).

`maintain daily` passes `--skip-monitors` for this package (guest upgrade only).

## After deploy

1. Get IP from query output or inventory.
2. **Web UI:** `http://<guest-ip>:3001` (LAN), SSH port-forward or restricted direct HTTP for OCI admin when `oci.admin_ingress` is set, or `https://status-ext.dukk.org` for the public-edge status page only.
3. **First run:** create the admin account matching vault credentials.

## Email notifications

Managed via `notifications[]` `type: smtp` (see above) — no UI setup needed. LAN
instance uses internal postfix-relay via `use_mail_relay`; guest baseline configures OS
mail on Proxmox LXCs.

## Related

- [AGENTS.md — Uptime Kuma](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/uptime-kuma.config.schema.json`](../../../apps/hdc-cli/schema/uptime-kuma.config.schema.json)
- OCI: [`docs/manually-deployed/oci-compute.md`](../../../docs/manually-deployed/oci-compute.md)
