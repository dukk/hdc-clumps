# GitLab CE (`gitlab`)

GitLab Community Edition on Proxmox LXC (Docker Compose, Omnibus container). Public HTTPS access is via **nginx-waf** using `gitlab.external_url` in config.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json` — set `gitlab.external_url` (`https://…`), `proxmox.host_id`, `proxmox.lxc.vmid`
- **Inventory:** [`inventory/manual/systems/gitlab-a.json`](../../../inventory/manual/systems/gitlab-a.json); [`inventory/manual/services/gitlab.json`](../../../inventory/manual/services/gitlab.json)
- **Resources:** GitLab CE needs substantial RAM — example defaults are 4 vCPU, 8 GiB RAM, 64 GiB rootfs. Confirm hypervisor headroom before deploy.
- **nginx-waf:** reverse-proxy site pointing at `http://<ct-ip>:80` after deploy

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker GitLab CE |
| `maintain` | Re-push Omnibus config; `docker compose pull` + `up -d`; guest baseline |
| `query` | Config summary; `--live` for `/-/health` |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs run service gitlab deploy -- --instance a
node apps/hdc-cli/cli.mjs run service gitlab query -- --live
node apps/hdc-cli/cli.mjs run service gitlab maintain --
```

## Common flags

`--instance a`, `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--skip-upgrade` (maintain), `--skip-clamav` (maintain), `--live` (query), `--skip-compose-down`, `--dry-run`, `--yes` (teardown).

## After deploy

1. **First boot** can take several minutes — deploy waits for `/-/health`.
2. **Root password:** inside the container at `/etc/gitlab/initial_root_password` (valid ~24h after first boot). Deploy logs how to retrieve it; never printed on stderr.
3. **CT IP:** from deploy/query `upstream_url` (e.g. `http://192.0.2.123:80`).
4. **Inventory:** set `access.nodes[0].ip` on `gitlab-a.json`.
5. **BIND:** forward A record for the hostname in `gitlab.external_url`.
6. **nginx-waf:** add a site with upstream to the CT IP on port 80.
7. **Git SSH:** clones use `ssh_host_port` on the CT IP (default `2222`), not nginx-waf — e.g. `git clone ssh://git@gitlab.example.invalid:2222/group/project.git` when DNS points at the CT or you use the CT IP.
8. **Nagios:** `node apps/hdc-cli/cli.mjs run service nagios maintain --` after BIND A record exists.

## Upgrades

`maintain` without `--skip-upgrade` pulls a newer image and restarts the container. GitLab may run database migrations on restart — snapshot or back up the `gitlab-data` Docker volume first.

## Related

- [AGENTS.md](../../../AGENTS.md)
- [nginx-waf README](../nginx-waf/README.md)
- Schema: [`apps/hdc-cli/schema/gitlab.config.schema.json`](../../../apps/hdc-cli/schema/gitlab.config.schema.json)
