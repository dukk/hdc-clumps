# Mosquitto (`mosquitto`)

Eclipse Mosquitto MQTT broker on Proxmox LXC with username/password auth and TLS via internal **step-ca** ACME.

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `config.json` (hdc-private)
- **Inventory:** [`inventory/manual/systems/mosquitto-a.json`](../../../inventory/manual/systems/mosquitto-a.json), [`inventory/manual/services/mosquitto.json`](../../../inventory/manual/services/mosquitto.json)
- **step-ca:** deployed and reachable; ACME enabled (`step_ca.enable_acme`)
- **BIND:** internal A record for `mosquitto.tls.cert_name` → CT IP (required for certbot http-01 against step-ca)
- **Vault:** per-user `password_vault_key` entries in `mosquitto.users[]`
- **ACME email:** `HDC_MOSQUITTO_ACME_EMAIL` in `.env` or `mosquitto.tls.acme_email` in config (falls back to `HDC_NGINX_LE_EMAIL`)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC provision + Mosquitto apt install + step-ca TLS + config push |
| `maintain` | Re-apply config/ACL/passwords; optional `--renew-certs`; guest baseline |
| `query` | Config summary; `--live` checks `mosquitto` service and TLS cert |
| `teardown` | Destroy LXC (`--dry-run`, `--yes`) |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_MOSQUITTO_PASSWORD_HOMEASSISTANT
node apps/hdc-cli/cli.mjs run service mosquitto deploy -- --instance a
node apps/hdc-cli/cli.mjs run service mosquitto query -- --live
node apps/hdc-cli/cli.mjs run service mosquitto maintain -- --renew-certs
```

## Home Assistant

1. Trust the step-ca root (same cert as nginx-waf / other internal TLS clients).
2. Settings → Devices & services → MQTT → broker `mqtt.home.example.invalid`, port **8883**, TLS enabled.
3. Username/password from vault keys in config.

Plaintext port **1883** is disabled by default (`plain_listener.enabled: false`).

## TLS renewal

step-ca certificates are short-lived. Deploy installs a systemd timer (`hdc-mosquitto-cert-renew.timer`, every 12h). Run `maintain --renew-certs` to force renewal.

## Flags

`--instance a`, `--system-id mosquitto-a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-cert-renew` (maintain), `--renew-certs` (maintain), guest baseline skips.

Static IP: set `deployments[].proxmox.lxc.ip` with `defaults.proxmox.network.gateway`, or `proxmox.lxc.ip_config` as `192.0.2.x/24,gw=192.0.2.1`.

## Related

- Schema: [`apps/hdc-cli/schema/mosquitto.config.schema.json`](../../../apps/hdc-cli/schema/mosquitto.config.schema.json)
- step-ca: [`clumps/services/step-ca/README.md`](../step-ca/README.md)
