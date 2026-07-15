# Splunk (`splunk`)

Single Splunk Free node on Proxmox QEMU (optional data disk for `/opt/splunk/var`).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `splunk.version` and `splunk.build` from the official `.deb` filename
- **Inventory:** [`inventory/manual/systems/vm-splunk-a.json`](../../../inventory/manual/systems/vm-splunk-a.json); [`inventory/manual/services/splunk.json`](../../../inventory/manual/services/splunk.json)
- **Vault:** `HDC_SPLUNK_ADMIN_PASSWORD` (required)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU clone, install `.deb`, accept Free license, set admin password |
| `maintain` | Re-push `server.conf` / `inputs.conf`; optional package upgrade |
| `query` | `splunk status`, version, HTTP/mgmt probes, disk usage |

```bash
node apps/hdc-cli/cli.mjs run service splunk deploy -- --destroy-existing
node apps/hdc-cli/cli.mjs run service splunk query --
```

## Common flags

`--destroy-existing`, `--skip-provision`, `--skip-install`, `--skip-package-upgrade`, `--dry-run`.

Exactly one `standalone` deployment (Splunk Free — no clustering).

## After deploy

1. **Web:** `https://<guest-ip>:8000` (Splunk Web; mgmt port may also appear in query).
2. **Login:** admin + password from vault `HDC_SPLUNK_ADMIN_PASSWORD`.
3. Forwarders and searches use standard Splunk ports per your `inputs.conf`.

## Related

- [AGENTS.md — Splunk](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/splunk.config.schema.json`](../../../apps/hdc-cli/schema/splunk.config.schema.json)
