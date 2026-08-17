# Home Assistant (`homeassistant`)

Deploy **Home Assistant OS** as a Proxmox QEMU VM with optional USB passthrough for Zigbee/Z-Wave coordinators.

## Prerequisites

- **Inventory:** [`inventory/manual/systems/vm-homeassistant-a.json`](../../../inventory/manual/systems/vm-homeassistant-a.json)
- **Config:** `clumps/services/homeassistant/config.json` (copy from [`config.example.json`](config.example.json))
- **Proxmox:** `clumps/infrastructure/proxmox/config.json` with target host (e.g. `pve-h`)
- **SSH** to the Proxmox node for image download (`unxz`) and USB preflight (`lsusb`)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Import HAOS OVA qcow2, create VM, USB passthrough, start, wait for HTTP `:8123` |
| `maintain` | Strip leftover hdc `http:` YAML (HTTP lives in the HA UI); write marked `notify.apprise` when enabled; HTTP health probe; push **managed** UI automations; `--reapply-usb` to refresh USB mapping |
| `query` | Config summary; `--live` for Proxmox guest + HTTP probe; `--import --yes` pulls integrations + UI automations/scripts/scenes into split sidecars |
| `teardown` | Destroy QEMU guest (`--dry-run`, `--yes`) |

```bash
hdc run service homeassistant deploy -- --instance a --destroy-existing
hdc run service homeassistant maintain -- --instance a
hdc run service homeassistant query -- --live
hdc run service homeassistant query -- --import --yes
```

## Managed automations (`maintain`)

Author UI automations under `automations/<id>.json` in hdc-private (or via `$hdc.include` from root `config.json`). Set `"managed": true` to opt in to push. On `maintain`, hdc POSTs each managed entry to `/api/config/automation/config/{id}` (same endpoint as the HA UI editor).

Flags: `--skip-automations`, `--automation <id>`, `--dry-run`.

Imported sidecars without `managed: true` are left alone (import remains pull-only). Scripts/scenes are not pushed in v1.

## Config import (`query --import`)

Read-only snapshot into hdc-private via the HA REST API (long-lived access token). Writes:

- `integrations/<domain>.json` — one file per integration domain (config entry metadata; HA does not expose `data`/`options` over REST)
- `automations/<id>.json`, `scripts/<id>.json`, `scenes/<id>.json` — UI-managed YAML configs

Vault: `HDC_HOMEASSISTANT_TOKEN` (or `homeassistant.api.token_vault_key`). Create the token under **Settings → People → Long-lived access tokens**. The same token may be reused for the homepage HA widget (`HDC_HOMEPAGE_HA_TOKEN`) if you store it under both keys. Required for `query --import` and for `maintain` automation sync.

**Limits:** Raw `packages/*.yaml` and integration options (hosts, API keys) are not available over REST. Import does not push changes back to HA — use `managed: true` + `maintain` for that.

## USB passthrough

- Prefer **vendor:product** IDs (`vvvv:pppp` from `lsusb` on the Proxmox host), not USB port numbers.
- Deploy auto-discovers when exactly one coordinator-like device is present; otherwise set `proxmox.qemu.usb[].id` or pass `--usb-id vvvv:pppp`.
- Use a **USB 2.0** port/extension cable for dongle stability.

## Static IP

HAOS does not use Ubuntu cloud-init. After first boot, set the configured static IP in **Settings → System → Network** if the deploy HTTP wait fails (match `proxmox.qemu.ip` in `config.json`, e.g. `192.0.2.39/24`, gw `192.0.2.1`, DNS BIND).

## nginx-waf / Cloudflare (public URL)

When `homeassistant.public_url` is `https://…` and **nginx-waf** proxies to port `8123`, Home Assistant must trust the WAF nodes or proxied requests return **400 Bad Request** (not 502). Latest HA moved HTTP (including `trusted_proxies`) to the UI.

Set WAF LAN IPs (`vm-nginx-waf-a` / `vm-nginx-waf-b`, e.g. `192.0.2.40` / `192.0.2.41`) under **Settings → System → Network** (trusted proxies). hdc does **not** write `http:` / `trusted_proxies` to `configuration.yaml`. `deploy` / `maintain` **strip** any leftover `# hdc: reverse-proxy` block so the UI owns HTTP. `--skip-reverse-proxy` is a no-op.

Do **not** put `homeassistant:` (external_url / internal_url / location) in `configuration.yaml` — that locks General settings in the UI. Set those under **Settings → System → Network** (URLs) and **Settings → System → General** (home location / timezone) instead.

## Apprise notify

hdc writes a marked YAML `notify:` platform (HA still requires YAML for this integration). Enable with `homeassistant.apprise` in clump config (`enabled`, `name`, `config_url`). Applied on `deploy` / `maintain` in the same VM stop as the HTTP strip:

```yaml
# hdc: apprise notify begin
notify:
  - name: apprise
    platform: apprise
    config: http://apprise-a.home.example.invalid:8000/get/ha
# hdc: apprise notify end
```

If a non-hdc root `notify:` key already exists, hdc logs and skips the merge (does not corrupt YAML). Service is `notify.apprise`; `target` maps to Apprise tags on the `ha` key.

Manual fallback: **Terminal & SSH** add-on, or edit `supervisor/homeassistant/configuration.yaml` on HAOS data partition 8 while the VM is stopped.

## Common flags

`--instance a`, `--system-id`, `--destroy-existing`, `--skip-provision`, `--usb-id`, `--no-wait-http`, `--reapply-usb`, `--skip-reverse-proxy`, `--skip-automations`, `--automation <id>`, `--no-report`.

Vault: `HDC_HOMEASSISTANT_TOKEN` for `query --import` and managed automation sync. Pair ZHA/Z-Wave in the Home Assistant UI after deploy.
