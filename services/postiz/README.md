# Postiz (HDC service package)

AI-powered social media scheduling ([gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app)), deployed as a **native** stack on Proxmox LXC (PostgreSQL, Redis, Temporal dev server, pnpm build, nginx, systemd). Mirrors the [community-scripts Postiz LXC installer](https://community-scripts.org/scripts/postiz).

## Prerequisites

- Copy `config.example.json` to `config.json` and set `proxmox.host_id`, `proxmox.lxc.vmid`, and optional `postiz.public_url`.
- Vault secrets `HDC_POSTIZ_DB_PASSWORD` and `HDC_POSTIZ_JWT_SECRET` (auto-generated on first deploy if missing).
- **8 GiB RAM minimum** on the LXC — the `pnpm run build` step needs a large Node heap.

## Commands

```bash
hdc run service postiz deploy --
hdc run service postiz query -- --live
hdc run service postiz maintain --
hdc run service postiz maintain -- --rebuild
hdc run service postiz teardown -- --yes
```

## URL and rebuild

`NEXT_PUBLIC_*` variables are baked at **build** time. The frontend will keep calling the **old** API origin until you rebuild — a restart that only rewrites `.env` is not enough. After changing `postiz.public_url` or social keys in `postiz.env_extra`, run:

```bash
hdc run service postiz maintain -- --rebuild
```

Or on the guest: `postiz-rebuild`.

Behind nginx-waf, guest nginx must pass `X-Forwarded-Proto` from the WAF (`$http_x_forwarded_proto`), not `$scheme` (the LXC is always HTTP). Maintain re-pushes that map.

When `postiz.mail.enabled` is true, hdc writes Postiz `EMAIL_PROVIDER=nodemailer` plus `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_FROM_ADDRESS` (no empty SMTP auth). Do not use Vaultwarden-style `SMTP_*` keys.

## Status

The upstream community script is marked *in development*. Pin `postiz.version` to a validated release tag when moving toward production.
