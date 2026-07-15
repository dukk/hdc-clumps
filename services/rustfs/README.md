# RustFS (`rustfs`)

S3-compatible distributed object storage (MNMD cluster) on four Proxmox LXC nodes with Docker. Public HTTPS is typically via **nginx-waf** using `rustfs.s3_public_url` and `rustfs.console_public_url` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — exactly **four** deployments (`rustfs-a` … `rustfs-d`), static `ip_config` per node, distinct `vmid`, and resolvable peer hostnames for `RUSTFS_VOLUMES`
- **Inventory:** `inventory/manual/systems/rustfs-{a,b,c,d}.json`; `inventory/manual/services/rustfs.json`
- **Vault:** `HDC_RUSTFS_ACCESS_KEY` and `HDC_RUSTFS_SECRET_KEY` (auto-generated on first deploy if missing)
- **DNS:** internal BIND records for each node hostname (or set `rustfs.cluster_dns_suffix`)
- **nginx-waf:** S3 API site (all four CT IPs on port 9000, `client_max_body_size: "0"`) and console site (port 9001)

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Provision 4 LXCs + Docker RustFS per node (sequential a→d) |
| `maintain` | Re-push compose + `.env`; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for per-node Docker + `/health` |
| `teardown` | Optional compose down, destroy LXC (reverse order d→a when full cluster) |

```bash
node apps/hdc-cli/cli.mjs run service rustfs deploy --
node apps/hdc-cli/cli.mjs run service rustfs deploy -- --instance a
node apps/hdc-cli/cli.mjs run service rustfs query -- --live
node apps/hdc-cli/cli.mjs run service rustfs maintain --
```

## Common flags

`--instance a|b|c|d`, `--system-id rustfs-a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-cluster-wait` (deploy), `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## Storage notes

Production MNMD expects **JBOD physical disks** per node. On LXC home-lab setups, four subdirectories under `/opt/rustfs/data/rustfs{1..4}` on a large rootfs is acceptable with `rustfs.unsafe_bypass_disk_check: true` (lab only).

Default container user is UID **10001** — install scripts `chown` data and logs accordingly.

## After deploy

1. **CT IPs:** from deploy/query `upstream_s3` per node (e.g. `http://192.0.2.x:9000`).
2. **Inventory:** set `access.nodes[0].ip` on each `rustfs-{a,b,c,d}.json`.
3. **Internal DNS:** ensure peer hostnames in `RUSTFS_VOLUMES` resolve between all four nodes.
4. **BIND:** A records for hostnames in `rustfs.s3_public_url` and `rustfs.console_public_url` → nginx-waf WAN IP.
5. **nginx-waf** (`clumps/services/nginx-waf/config.json`):
   - **S3 site** (`rustfs-s3` or similar): upstream pool of all four CT IPs on port **9000**; set `client_max_body_size: "0"` for large object uploads; use `client_ip: cloudflare` when proxied through Cloudflare.
   - **Console site** (`rustfs-console`): upstream to any healthy node on port **9001**.
6. **Maintain edge:**
   ```bash
   node apps/hdc-cli/cli.mjs run service bind maintain --
   node apps/hdc-cli/cli.mjs run service nginx-waf maintain -- --site rustfs-s3 --site rustfs-console
   ```
7. **Credentials:** rotate default RustFS admin credentials after first login; vault keys are used for S3 API access.

## Related

- Schema: [`apps/hdc-cli/schema/rustfs.config.schema.json`](../../../apps/hdc-cli/schema/rustfs.config.schema.json)
- Upstream: [RustFS MNMD docs](https://docs.rustfs.com/installation/linux/multiple-node-multiple-disk.html), [Docker install](https://docs.rustfs.com/installation/docker/)
