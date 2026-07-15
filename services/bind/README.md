# BIND DNS (`bind`)

Authoritative DNS on Proxmox QEMU VMs: primary/secondary pair, zone files from `config.json`, TSIG zone transfers.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (root lists `zones[]` via `{ "$hdc.include": "zones/<id>.json" }`; one zone object per file under `zones/`; `deployments[].proxmox.qemu.ip` for static cloud-init CIDR; no per-deployment `vmid`). Inline `zones[]` in a single file remains supported. Large `records[]` may use nested includes inside a zone file.
- **Inventory:** [`inventory/manual/systems/vm-bind-a.json`](../../../inventory/manual/systems/vm-bind-a.json), [`vm-bind-b.json`](../../../inventory/manual/systems/vm-bind-b.json)
- **TSIG:** Deploy auto-generates `bind.tsig_secret` in `config.json` (and syncs `HDC_BIND_TSIG_KEY` in the vault) when missing. Rotate with `--regenerate-tsig`. Manual: `dnssec-keygen -a HMAC-SHA256 -b 256 -n HOST .`
- **Forwarders (plain):** `bind.forwarders` defaults to `1.1.1.1` and `1.0.0.1` when `forward_upstream` is absent or `mode` is `plain`.
- **Forwarders (ODoH):** Set `bind.forward_upstream.mode` to `odoh` to install **dnscrypt-proxy** on each BIND VM and forward recursive queries to Cloudflare via Oblivious DoH (RFC 9230, experimental). BIND uses `127.0.0.1:5300` locally; configure `server` (default `odoh-cloudflare`), `relay` (default `odohrelay-crypto-sx`), and `listen` in config.
- **Cloudflare fallback:** On a forward zone, set `cloudflare_fallback` to merge records from `clumps/infrastructure/cloudflare/config.json` at deploy/maintain time. Local `records[]` override Cloudflare on conflict. Default `exclude_types: ["NS"]`. Refresh Cloudflare config after public DNS edits, then run `bind maintain`.

## Provisioning

- **Static IP:** each `proxmox-qemu` deployment must set `proxmox.qemu.ip` (e.g. `192.0.2.2/24`) plus matching `configure.ssh.host`.
- **VMID:** not stored in config. Deploy allocates the next free cluster VMID (from `defaults.proxmox.qemu.vmid_start`, default `100`) and rediscovers existing guests by `hostname` (Proxmox guest name).
- **Root disk:** set `defaults.proxmox.qemu.rootfs_gb` (e.g. `16`). Deploy resizes `scsi0` after clone; maintain grows the Proxmox disk and guest filesystem when config exceeds live size (`--skip-disk-resize` to skip).
- **Logging:** maintain pushes `/etc/bind/hdc/logging.conf` to discard BIND `security` and `queries` categories (stops high-volume cache/recursion deny lines on syslog from clients outside `allow_query_cidrs`).
- **Log purge:** maintain/deploy install `/etc/cron.d/hdc-bind-log-purge` — daily check; when root free space is below `bind.log_purge.threshold_free_percent` (default 15%), purge journal, apt cache, and old syslog rotations. Disable with `bind.log_purge.enabled: false` or `--skip-log-purge`.

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Clone Ubuntu VMs, auto-allocate VMID, cloud-init static IP, install BIND (primary before secondary) |
| `maintain` | Grow root disk when `rootfs_gb` exceeds live size; re-push dnscrypt-proxy (when ODoH) and `named.conf.options` on all nodes; re-render zones on primary; verify SOA serial; install log-purge cron; guest Linux baseline (local admin from `HDC_ADMIN_USER` + ClamAV; `--skip-admin-user`, `--skip-clamav`) |
| `query` | `named` status; per-zone `dig SOA` |

```bash
node apps/hdc-cli/cli.mjs run service bind deploy -- --destroy-existing
node apps/hdc-cli/cli.mjs run service bind maintain --
```

## Common flags

`--instance a|b`, `--destroy-existing`, `--skip-provision`, `--skip-install`, `--regenerate-tsig`, `--skip-disk-resize`, `--skip-log-purge`, `--skip-admin-user`, `--skip-clamav`, `--skip-guest-agent`, `--skip-apt`, `--dry-run`, `--no-report`.

## After deploy

1. **DNS service:** UDP/TCP port **53** on each VM IP (from `deployments[].proxmox.qemu.ip` or query).
2. **No web UI.** Test: `dig @<primary-ip> SOA <your-zone>`.
3. Point resolvers or downstream DNS at the primary/secondary IPs. Recursive queries use plain forwarders or ODoH per `bind.forward_upstream` / `bind.forwarders`.
4. For Let's Encrypt DNS-01 elsewhere, reuse `HDC_BIND_TSIG_KEY` in nginx/nginx-waf packages.

## Related

- [AGENTS.md — BIND](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/bind.config.schema.json`](../../../apps/hdc-cli/schema/bind.config.schema.json)
