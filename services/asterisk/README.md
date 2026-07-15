# Asterisk (`asterisk`)

Asterisk PBX (PJSIP) on Proxmox with config-driven Twilio Elastic SIP Trunk examples.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` in hdc-private
- **Inventory:** `inventory/manual/systems/asterisk-a.json` (LXC) or `vm-asterisk-a.json` (QEMU); [`inventory/manual/services/asterisk.json`](../../../inventory/manual/services/asterisk.json)
- **Vault (Twilio):** `HDC_TWILIO_SIP_USERNAME`, `HDC_TWILIO_SIP_PASSWORD` when `asterisk.twilio.enabled`
- **Twilio setup:** [`examples/twilio/README.md`](examples/twilio/README.md)

## Deploy modes

| Mode | `system_id` | Summary |
| --- | --- | --- |
| `proxmox-lxc` | `asterisk-a` | LXC + apt `asterisk` (default) |
| `proxmox-qemu` | `vm-asterisk-a` | Ubuntu VM clone + SSH |
| `configure-only` | either | Push config to existing guest |

## Commands

| Verb | Purpose |
| --- | --- |
| `deploy` | Provision guest + install Asterisk + render Twilio trunk/dialplan |
| `maintain` | Re-push config; optional apt upgrade; guest Linux baseline |
| `query` | Config summary; `--live` for systemd + PJSIP preview |
| `teardown` | Destroy LXC or QEMU guest |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_SIP_USERNAME
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_SIP_PASSWORD
node apps/hdc-cli/cli.mjs run service asterisk deploy -- --instance a
node apps/hdc-cli/cli.mjs run service asterisk maintain --
node apps/hdc-cli/cli.mjs run service asterisk query -- --live
```

## Common flags

`--instance a`, `--system-id`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--destroy-existing` (QEMU), `--skip-provision`, `--skip-package-upgrade` (maintain), `--skip-clamav`, `--live` (query), `--dry-run`, `--yes` (teardown).

## Twilio

See [`examples/twilio/`](examples/twilio/) for Console checklist and field mapping. SIP/RTP must be forwarded on your **edge firewall** — not via nginx-waf.

Default outbound prefix: `9` + E.164 (e.g. `9+15551234567`).

## Related

- [AGENTS.md — Asterisk](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/asterisk.config.schema.json`](../../../apps/hdc-cli/schema/asterisk.config.schema.json)
