# Postiz (HDC service package)

AI-powered social media scheduling ([gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app)), deployed as a **native** stack on Proxmox LXC (PostgreSQL, Redis, Temporal dev server, pnpm build, nginx, systemd). Mirrors the [community-scripts Postiz LXC installer](https://community-scripts.org/scripts/postiz).

## Prerequisites

- Copy `config.example.json` to `config.json` and set `proxmox.host_id`, `proxmox.lxc.vmid`, and optional `postiz.public_url`.
- Vault secrets `HDC_POSTIZ_DB_PASSWORD` and `HDC_POSTIZ_JWT_SECRET` (auto-generated on first deploy if missing).
- **8 GiB RAM minimum** on the LXC — the `pnpm run build` step needs a large Node heap.

## Commands

```bash
node apps/hdc-cli/cli.mjs run service postiz deploy --
node apps/hdc-cli/cli.mjs run service postiz query -- --live
node apps/hdc-cli/cli.mjs run service postiz maintain --
node apps/hdc-cli/cli.mjs run service postiz maintain -- --rebuild
node apps/hdc-cli/cli.mjs run service postiz teardown -- --yes
```

## URL and rebuild

`NEXT_PUBLIC_*` variables are baked at **build** time. After changing `postiz.public_url` or social keys in `postiz.env_extra`, run:

```bash
node apps/hdc-cli/cli.mjs run service postiz maintain -- --rebuild
```

Or on the guest: `postiz-rebuild`.

## Status

The upstream community script is marked *in development*. Pin `postiz.version` to a validated release tag when moving toward production.
