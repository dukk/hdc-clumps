# Postfix SMTP relay (`postfix-relay`)

Outbound SMTP relay on Proxmox LXC (or existing SSH host): Postfix + SASL to a provider such as SMTP2GO.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** optional `inventory/manual/systems/postfix-relay-a.json`
- **Vault:** `HDC_POSTFIX_RELAY_SMTP_USER`, `HDC_POSTFIX_RELAY_SMTP_PASSWORD` (keys from `smtp.auth_*_vault_key` in config)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision (unless `deploy.skip_provision`) + Postfix relay config |
| `maintain` | Re-apply relay configuration; `--apply-network` to set static `proxmox.lxc.ip_config` on existing CT |
| `query` | Postfix/service status |

```bash
node apps/hdc-cli/cli.mjs run service postfix-relay deploy --
node apps/hdc-cli/cli.mjs run service postfix-relay maintain --
node apps/hdc-cli/cli.mjs run service postfix-relay maintain -- --apply-network
```

## Common flags

`--apply-network` (maintain), `--dry-run`, `--no-report`.

## After deploy

1. **SMTP submission:** relay listens per `postfix.inet_interfaces` (example config: all interfaces on the guest IP).
2. **Port:** typically **25** / **587** depending on your `master.cf` and provider (`relayhost` example: `[mail.smtp2go.com]:587`).
3. Point LAN apps at `smtp://postfix-relay.home.example.invalid:25` (or `192.0.2.60`) **without** SMTP2GO credentials — see `client_defaults` in config.
4. Linux guests, Proxmox hypervisors, and home clients get a **Postfix satellite** automatically via guest baseline / `proxmox maintain` / client maintain (`--skip-mail-relay` to opt out).
5. No web UI on the relay itself.

## Related

- Example configure host in config: `192.0.2.48` (replace with your deployment IP)
