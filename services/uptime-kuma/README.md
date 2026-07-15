# Uptime Kuma (`uptime-kuma`)

Deploy Uptime Kuma on Proxmox LXC or Oracle Cloud VM (Node 22, systemd, port 3001), upgrade releases, probe health, and reconcile monitors and Discord notifications from config.

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
node apps/hdc-cli/cli.mjs run service uptime-kuma deploy -- --instance a
node apps/hdc-cli/cli.mjs run service uptime-kuma deploy -- --instance ext-a
node apps/hdc-cli/cli.mjs run service uptime-kuma maintain -- --instance ext-a
node apps/hdc-cli/cli.mjs run service uptime-kuma query -- --live
```

## Monitor bootstrap

1. Seed `monitors[]` from homepage dashboard targets:

   ```bash
   node apps/hdc-cli/cli.mjs run service uptime-kuma query -- --import-from-homepage --yes
   ```

2. Review/edit monitors in hdc-private `config.json` (`managed: true` on hdc-owned entries). Use `$hdc.include` for split files under `monitors/` or `monitors-public/`.

3. Apply to live Uptime Kuma:

   ```bash
   node apps/hdc-cli/cli.mjs run service uptime-kuma maintain -- --dry-run
   node apps/hdc-cli/cli.mjs run service uptime-kuma maintain -- --instance ext-a
   ```

## Discord notifications

Add to config (root or per-deployment):

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
  }
]
```

`maintain` syncs notifications before monitors. Use `--skip-notifications` to skip.

## OCI deploy (`oci-vm`)

1. Configure [`oci-compute`](../../infrastructure/oci-compute/) (VCN, NSG with TCP 22/80/443, optional restricted TCP 3001, instance `uptime-kuma-ext-a`).
2. `node apps/hdc-cli/cli.mjs run infrastructure oci-compute deploy -- --resource uptime-kuma-ext-a --yes`
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

## Email notifications (manual)

For `uptime-kuma-a`, configure SMTP in the UK UI (Settings → Notifications → Email). Use internal postfix-relay (`postfix-relay.home.example.invalid:25`, no auth). Guest baseline configures OS mail on Proxmox LXCs.

## Related

- [AGENTS.md — Uptime Kuma](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/uptime-kuma.config.schema.json`](../../../apps/hdc-cli/schema/uptime-kuma.config.schema.json)
- OCI: [`docs/manually-deployed/oci-compute.md`](../../../docs/manually-deployed/oci-compute.md)
