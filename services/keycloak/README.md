# Keycloak (`keycloak`)

Keycloak on Proxmox LXC via Docker Compose, with either bundled PostgreSQL sidecar or external PostgreSQL.

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/keycloak-a.json`](../../../inventory/manual/systems/keycloak-a.json), [`inventory/manual/services/keycloak.json`](../../../inventory/manual/services/keycloak.json)
- **Admin user:** `keycloak.admin_user` in config (or env `HDC_KEYCLOAK_ADMIN_USER`; default `admin`)
- **Vault:** `HDC_KEYCLOAK_ADMIN_PASSWORD` and `HDC_KEYCLOAK_DB_PASSWORD` (for bundled DB; optional for external based on config)

## Hostname / reverse proxy

Set `keycloak.external_url` to the public HTTPS URL served by nginx-waf (e.g. `https://keycloak.hdc.dukk.org`). Deploy/maintain map that to `KC_HOSTNAME` and set `KC_HTTP_ENABLED=true` + `KC_PROXY_HEADERS=xforwarded` for edge TLS. Optional `public_url` should match `external_url`; a mismatch is logged as a warning.

## Database modes

- `database.mode: "bundled"`: compose includes `postgres` sidecar
- `database.mode: "external"`: compose only runs Keycloak and connects to external PostgreSQL from `database.external`

## Realms, users, clients, and identity providers

Declare managed realms under `defaults.keycloak.realms[]` (or per deployment). Use `$hdc.include` to split one file per realm under `realms/`:

```json
"realms": [
  { "$hdc.include": "realms/hdc.json" }
]
```

Each realm file sets `id`, `realm` (Keycloak name; not `master`), login flags, optional `mail`, `users[]`, `clients[]`, and optional `identity_providers[]`. Every user needs `password_vault_key` (auto-generated into the vault on first maintain when missing). Confidential OIDC clients need `secret_vault_key` (same vault mint behavior). Upstream identity providers use `client_id` (Entra Application ID) plus `client_secret_vault_key` — the secret is **never** auto-minted (create it in Entra and `hdc secrets set`).

### OIDC clients

```json
"clients": [
  {
    "client_id": "hdc-web",
    "name": "HDC Web",
    "enabled": true,
    "public_client": false,
    "standard_flow_enabled": true,
    "direct_access_grants_enabled": false,
    "redirect_uris": ["https://hdc.example.invalid/api/auth/oidc/callback"],
    "web_origins": ["https://hdc.example.invalid"],
    "secret_vault_key": "HDC_WEB_OIDC_CLIENT_SECRET"
  }
]
```

### Microsoft identity provider

Pair with a managed Entra app in the [azure](../../infrastructure/azure/) package (redirect URI `{external_url}/realms/{realm}/broker/{alias}/endpoint`). After `azure deploy`, pin the Application (client) ID into `client_id`, create an Entra client secret, and store it in the vault.

```json
"identity_providers": [
  {
    "alias": "microsoft",
    "provider_id": "microsoft",
    "enabled": true,
    "display_name": "Microsoft",
    "trust_email": true,
    "sync_mode": "IMPORT",
    "default_scope": "openid profile email",
    "client_id": "<entra-application-client-id>",
    "client_secret_vault_key": "HDC_KEYCLOAK_IDP_MICROSOFT_CLIENT_SECRET"
  }
]
```

### Email (postfix-relay)

Set `mail.enabled: true` on a realm to push Keycloak `smtpServer` from [postfix-relay](../postfix-relay/) `client_defaults` (hostname + port 25, no auth). Optional overrides: `mail.from`, `mail.from_display_name`, `mail.reply_to`. When `mail` is omitted or disabled, live SMTP is left unchanged.

```json
"mail": {
  "enabled": true,
  "from_display_name": "Example SSO"
}
```

Deploy/maintain reconcile via the Admin REST API after the stack is healthy:

| Flag | Effect |
|------|--------|
| `--skip-realms` | Skip Admin API reconcile |
| `--skip-identity-providers` | Skip IdP create/update/prune |
| `--realm <id\|name>` | Only that realm |
| `--prune` | Delete unmanaged users/clients/IdPs in managed realms (built-in Keycloak clients are never pruned); delete non-`master` realms not listed in config |
| `--rotate-user-passwords` | Reset passwords from vault for existing users |
| `--rotate-client-secrets` | Push vault client secrets onto live confidential clients |
| `--rotate-idp-secrets` | Push vault IdP client secrets onto live identity providers |
| `--dry-run` | Log planned changes without applying |

Empty or omitted `realms` is a no-op (does not wipe live realms).

Optional `keycloak.api_url` overrides the Admin API base (else `external_url` / `public_url`, else `http://<ct-ip>:<host_port>`).

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | LXC + Docker Compose Keycloak; reconcile realms/users/clients/IdPs |
| `maintain` | Re-push env/compose; optional image refresh; reconcile realms/users/clients/IdPs |
| `query` | Config summary; `--live` for service health + realm/user/client/IdP drift |
| `teardown` | Optional compose down, destroy LXC |

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_KEYCLOAK_ADMIN_PASSWORD
node apps/hdc-cli/cli.mjs secrets set HDC_KEYCLOAK_DB_PASSWORD
node apps/hdc-cli/cli.mjs run service keycloak deploy --
node apps/hdc-cli/cli.mjs run service keycloak maintain -- --dry-run
node apps/hdc-cli/cli.mjs run service keycloak query -- --live
```

## Related

- [AGENTS.md — Keycloak section](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/keycloak.config.schema.json`](../../../apps/hdc-cli/schema/keycloak.config.schema.json)
- Example realm: [`realms/example.json`](realms/example.json)
- Azure Entra apps: [`docs/manually-deployed/azure.md`](../../../docs/manually-deployed/azure.md)