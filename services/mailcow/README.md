# Mailcow (HDC service package)

Deploy [mailcow-dockerized](https://github.com/mailcow/mailcow-dockerized) on Proxmox **LXC** or **QEMU VM** with Docker. Manages mail **domains**, **mailboxes**, and **aliases** via the Mailcow API, documents DNS (MX/SPF/DKIM/DMARC), and supports per-domain outbound delivery:

| `outbound.mode` | Behavior |
| --- | --- |
| `direct` | Mailcow sends mail directly from its public IP |
| `postfix-relay` | Outbound via the internal hdc [postfix-relay](../postfix-relay/) smarthost (no SMTP auth; same LAN trust as guest satellites) |

## Deploy modes

| Mode | System id | Guest access |
| --- | --- | --- |
| `proxmox-lxc` | `mailcow-a` | `pct exec` (privileged LXC + Docker nesting) |
| `proxmox-qemu` | `vm-mailcow-a` | SSH + optional `data_disk_gb` on `data_disk_storage` (e.g. `local-lvm-data`) |

QEMU sizing example: 32 GiB root on `local-lvm`, 64 GiB data disk for mail + Docker (`install_dir` under `/data/mailcow/…`, Docker `data-root` on the data mount).

## Config

Copy [`config.example.json`](config.example.json) to hdc-private `clumps/services/mailcow/config.json`.

Key blocks:

- `mailcow.hostname` — `MAILCOW_HOSTNAME` FQDN (e.g. `mailcow-a.home.example.invalid`), **not** a mail domain
- `mailcow.admin_url` — browser UI URL (often nginx-waf front door)
- `mailcow.api_url` — optional Mailcow API base (defaults to `https://{hostname}`); set to `https://<guest-ip>` when running `maintain` from a LAN workstation (uses insecure TLS for self-signed certs on the guest IP)
- `mailcow.domains[]` — domains to add in Mailcow; each has `outbound.mode`, `dns` templates, optional `mailboxes[]` and `aliases[]`
- `mailcow.dns_publish.cloudflare_dkim` — when true (default), publish DKIM TXT to Cloudflare after reconcile
- `install.install_dir` — default `/opt/mailcow-dockerized` (LXC); use `/data/mailcow/mailcow-dockerized` on QEMU with a data disk

LXC defaults: 6 GiB RAM, 4 vCPU, 40 GiB rootfs (privileged LXC + Docker nesting).

QEMU defaults (typical): 8 GiB RAM, 4 vCPU, 32 GiB rootfs + optional `data_disk_gb` / `data_disk_storage`.

## Vault secrets

| Key | When |
| --- | --- |
| `HDC_MAILCOW_DBPASS` | Auto-generated on first deploy if missing |
| `HDC_MAILCOW_DBROOT` | Auto-generated on first deploy if missing |
| `HDC_MAILCOW_REDISPASS` | Auto-generated on first deploy if missing |
| `HDC_MAILCOW_API_KEY` | Required for domain/mailbox/alias reconciliation on `deploy` / `maintain` (create in Mailcow UI after first boot) |
| `HDC_CLOUDFLARE_API_TOKEN` | Required for automatic DKIM TXT publish (repo `.env` or vault; same token as cloudflare package) |

Per-mailbox passwords use `domains[].mailboxes[].password_vault_key` (auto-generated on first maintain when missing).

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_MAILCOW_API_KEY
node apps/hdc-cli/cli.mjs secrets set HDC_MAILCOW_MAILBOX_ADMIN_EXAMPLE_INVALID_PASSWORD
```

## Commands

```bash
node apps/hdc-cli/cli.mjs run service mailcow deploy -- --instance a
node apps/hdc-cli/cli.mjs run service mailcow deploy -- --instance a --destroy-existing
node apps/hdc-cli/cli.mjs run service mailcow maintain --
node apps/hdc-cli/cli.mjs run service mailcow query -- --live
node apps/hdc-cli/cli.mjs run service mailcow teardown -- --dry-run
```

### Flags

| Verb | Flags |
| --- | --- |
| `deploy` | `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--destroy-existing`, `--skip-provision` (QEMU), `--skip-domains`, `--skip-cloudflare-dkim`, `--skip-mailboxes`, `--skip-aliases`, `--prune` |
| `maintain` | `--skip-upgrade`, `--skip-domains`, `--skip-cloudflare-dkim`, `--skip-mailboxes`, `--skip-aliases`, `--prune`, `--rotate-mailbox-passwords`, `--skip-baseline`, `--skip-clamav`, … |
| `query` | `--live` (reports domain/mailbox/alias drift vs config) |
| `teardown` | `--dry-run`, `--yes`, `--skip-compose-down` |

## DNS

`deploy` and `maintain` reconcile domains on the Mailcow server (add domain, DKIM, relayhost). When `HDC_CLOUDFLARE_API_TOKEN` is available and `mailcow.dns_publish.cloudflare_dkim` is not false, hdc **publishes DKIM TXT** to each matching Cloudflare zone automatically.

MX, SPF, and DMARC remain manual via BIND or [`cloudflare`](../infrastructure/cloudflare/) config. `maintain` and `query --live` also print a checklist:

- **MX** → `mailcow.hostname`
- **SPF** / **DMARC** — from `domains[].dns` in config
- **DKIM** — live from Mailcow API; auto-published to Cloudflare when enabled
- **Autodiscover** CNAME (optional)

For `postfix-relay` outbound domains, SPF in the example uses SMTP2GO-style includes; add provider DKIM CNAMEs per your relay upstream (see existing `example.invalid` Cloudflare records when using SMTP2GO).

## Guest baseline

`maintain` runs the standard Linux baseline (hdc user, admin, ClamAV) with **`--skip-mail-relay`** — Mailcow is the mail server, not a satellite client.

## Dependencies (manual)

- **BIND / Cloudflare** — publish DNS checklist records
- **nginx-waf** — optional HTTPS for admin UI
- **postfix-relay** — must exist when any domain uses `outbound.mode: postfix-relay`
