# FreePBX (`freepbx`)

FreePBX 17 on a Debian 12 Proxmox QEMU guest. The Asterisk package scripts stay in the repo; this package is the replacement PBX.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) copied to hdc-private
- **Inventory:** `operations/inventory/systems/virtual/vm-freepbx-a.json`
- **Image:** Debian 12 generic cloud qcow2 (not the Ubuntu template). Deploy imports it once as `proxmox.qemu.template_vmid`.
- **Vault:** `HDC_FREEPBX_ADMIN_PASSWORD` and `HDC_FREEPBX_DEBIAN_PASSWORD` are generated on first deploy if missing. Twilio trunk uses `HDC_TWILIO_SIP_USERNAME` and `HDC_TWILIO_SIP_PASSWORD`.

## Commands

| Verb | Purpose |
| --- | --- |
| `deploy` | Import Debian template if needed, clone, install FreePBX, pin RTP, create the Twilio trunk |
| `maintain` | Re-apply trunk/NAT/RTP and guest baseline (skips unattended-upgrades) |
| `query` | Config summary; `--live` for fwconsole, registrations, and admin HTTP |
| `teardown` | Destroy the QEMU guest (template is kept) |

```bash
hdc run service freepbx deploy -- --backup-guest vm-asterisk-a --backup-storage nas-1
hdc run service freepbx deploy -- --instance a
hdc run service freepbx query -- --live
```

`--backup-guest` only runs a Proxmox snapshot backup and does not deploy.

RTP defaults to **10000–12499** so existing SIP/RTP port forwards stay valid. Inbound calls have no extension destination until one is added in the FreePBX UI.

Guest baseline skips unattended-upgrades (Sangoma packages) unless `--enable-unattended-upgrades`. ClamAV scan is skipped unless `--clamav-scan`.

Re-run against an existing guest with `--redeploy-existing`. Rebuild the Debian template with `--build-template --destroy-existing`.
