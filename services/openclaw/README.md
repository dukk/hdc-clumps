# OpenClaw (personal AI agent)

Deploy [OpenClaw](https://openclaw.ai) on a Proxmox **QEMU Ubuntu** VM. The gateway runs as a native npm install with a systemd **user** service (loopback by default). Docker is optional for agent sandboxes.

## Prerequisites

- Proxmox Ubuntu QEMU cloud-init template (see `defaults.proxmox.qemu.template_vmid`)
- hdc-private `clumps/services/openclaw/config.json` with static IP, vmid, and `proxmox.host_id`
- Vault secrets (names only):
  - `HDC_OPENCLAW_GATEWAY_TOKEN` (auto-generated on first deploy if missing)
  - `HDC_OPENCLAW_ANTHROPIC_API_KEY` (or keys listed in `openclaw.env_secrets[]`)
- Inventory: `inventory/manual/systems/vm-openclaw-a.json`, `inventory/manual/services/openclaw.json`

## Config

Copy [`config.example.json`](config.example.json) to hdc-private. Key blocks:

| Block | Purpose |
| --- | --- |
| `defaults.proxmox.qemu` | Template vmid, CPU/RAM/disk |
| `deployments[].proxmox.qemu` | Per-node vmid, static `ip` CIDR |
| `openclaw.gateway.bind` | `loopback` (default) or `lan` |
| `openclaw.agents` | Model and sandbox settings |
| `openclaw.channels` | Messaging channel config (see OpenClaw docs) |
| `openclaw.env_secrets[]` | Map vault keys → guest env vars |

Example Telegram channel after setting `HDC_OPENCLAW_TELEGRAM_BOT_TOKEN`:

```json
"channels": {
  "telegram": {
    "enabled": true,
    "botToken": "${TELEGRAM_BOT_TOKEN}",
    "dmPolicy": "pairing"
  }
}
```

Add to `env_secrets`:

```json
{ "vault_key": "HDC_OPENCLAW_TELEGRAM_BOT_TOKEN", "guest_env": "TELEGRAM_BOT_TOKEN", "optional": true }
```

## Commands

```bash
node apps/hdc-cli/cli.mjs run service openclaw query --
node apps/hdc-cli/cli.mjs run service openclaw deploy -- --instance a
node apps/hdc-cli/cli.mjs run service openclaw maintain --
node apps/hdc-cli/cli.mjs run service openclaw query -- --live
node apps/hdc-cli/cli.mjs run service openclaw teardown -- --instance a --yes
```

### Deploy flags

| Flag | Effect |
| --- | --- |
| `--instance a` | Select `vm-openclaw-a` |
| `--destroy-existing` | Destroy existing vmid before clone |
| `--skip-provision` | Skip Proxmox clone (configure only) |
| `--skip-install` | Provision VM only |
| `--skip-existing` / `--redeploy-existing` | Existing guest policy |

### Maintain flags

| Flag | Effect |
| --- | --- |
| `--skip-upgrade` | Re-push config only (no `openclaw update`) |
| Guest baseline skips | `--skip-clamav`, `--skip-hdc-user`, … |

## Access (loopback default)

Gateway listens on `127.0.0.1:18789` inside the VM. From your workstation:

```bash
ssh -L 18789:127.0.0.1:18789 hdc@<vm-ip>
```

Open `http://127.0.0.1:18789` and authenticate with the gateway token from vault (`HDC_OPENCLAW_GATEWAY_TOKEN`).

## After deploy

1. Pin `openclaw.version` in config after validating `latest`.
2. Add channels in config + `maintain` (or Control UI over SSH tunnel).
3. See https://docs.openclaw.ai/channels for channel-specific setup.

## Teardown

Stops the gateway service (best effort) then destroys the QEMU guest. Use `--dry-run` first.
