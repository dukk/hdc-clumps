# Nginx web hosting (`nginx`)

Reverse proxy and static hosting with Let's Encrypt. Optional Proxmox QEMU provision or configure-only on existing SSH hosts.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (`sites[]`)
- **Inventory:** [`inventory/manual/systems/vm-nginx-a.json`](../../../inventory/manual/systems/vm-nginx-a.json); [`inventory/manual/services/nginx.json`](../../../inventory/manual/services/nginx.json)
- **Vault:** `HDC_NGINX_LE_EMAIL` (required); `HDC_BIND_TSIG_KEY` when `letsencrypt.challenge` is `dns-01`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Provision VM (optional) + nginx + certbot; push `sites[]` |
| `maintain` | Grow root disk when `defaults.proxmox.qemu.rootfs_gb` exceeds live size (`--skip-disk-resize`); re-push sites; `--renew-certs`; `--site <id>` (that site only; other vhosts unchanged) |
| `query` | nginx status, config test, upstream probes, cert expiry |

```bash
node apps/hdc-cli/cli.mjs run service nginx deploy -- --instance a
node apps/hdc-cli/cli.mjs run service nginx maintain --
```

`maintain -- --site <id>` updates only that site's vhost; other `hdc-*.conf` sites on the host are left as-is. Run full `maintain` (no `--site`) to prune sites removed from `config.json`.

## Common flags

`--instance a`, `--destroy-existing`, `--skip-provision`, `--renew-certs`, `--site <id>` (partial update only), `--skip-disk-resize`, `--dry-run`, `--skip-clamav`.

Set `defaults.proxmox.qemu.rootfs_gb` (e.g. `32`) for QEMU guests. Maintain grows the Proxmox `scsi0` volume and guest filesystem when config exceeds live size (`--skip-disk-resize` to skip).

## After deploy

1. **Access:** open each site by `server_name` / URL in `sites[]` (HTTPS after cert issuance).
2. **Example:** if a site proxies to an app, browse `https://<hostname-from-config>`.
3. No single fixed port in config — depends on `listen` in each site block (typically 80/443 on the VM IP).

## Related

- [AGENTS.md — Nginx](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/nginx.config.schema.json`](../../../apps/hdc-cli/schema/nginx.config.schema.json)
