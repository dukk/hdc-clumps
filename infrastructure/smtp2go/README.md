# SMTP2GO (HDC infrastructure)

Manage **sender domains**, **IP allowlist**, and **Restrict Senders** on your SMTP2GO account (add, verify, diff vs config). DNS records (SPF, DKIM, return-path, tracking CNAMEs) are reported as checklists for manual Cloudflare or BIND updates — this package does not publish DNS.

SMTP relay credentials for [`postfix-relay`](../../services/postfix-relay/) remain separate (`HDC_POSTFIX_RELAY_SMTP_USER`, `HDC_POSTFIX_RELAY_SMTP_PASSWORD`).

## Secrets

Store the SMTP2GO API key in the hdc vault (never commit):

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_SMTP2GO_API_KEY
```

Create the key in SMTP2GO Console → **Sending → API Keys** (enable sender domain, IP allowlist, and allowed-senders endpoints). You may also set `HDC_SMTP2GO_API_KEY` in repo `.env` (env takes precedence over vault).

## Config

Copy `config.example.json` to **hdc-private** as `clumps/infrastructure/smtp2go/config.json`, or bootstrap from the live account:

```bash
node apps/hdc-cli/cli.mjs run infrastructure smtp2go query -- --import --yes
```

Set `managed: true` on sender domains, `ip_allow_list`, or `allowed_senders` sections you want `maintain` to enforce.

**Import note:** `notes`, `spf`, `dmarc`, and `spf_variant` on sender domains are HDC-local only — import does not pull them from SMTP2GO. Re-import preserves them when the FQDN already existed in config.

**Restrict Senders:** `whitelist` or `blacklist` mode disables Sender Domains in SMTP2GO. Default `allowed_senders.mode` to `disabled` when using verified sender domains.

## Query

```bash
node apps/hdc-cli/cli.mjs run infrastructure smtp2go query --
node apps/hdc-cli/cli.mjs run infrastructure smtp2go query -- --domain hdc.example.invalid
node apps/hdc-cli/cli.mjs run infrastructure smtp2go query -- --import --yes
```

## Maintain

```bash
node apps/hdc-cli/cli.mjs run infrastructure smtp2go maintain --
node apps/hdc-cli/cli.mjs run infrastructure smtp2go maintain -- --dry-run
node apps/hdc-cli/cli.mjs run infrastructure smtp2go maintain -- --domain-id hdc-example-invalid
node apps/hdc-cli/cli.mjs run infrastructure smtp2go maintain -- --prune
node apps/hdc-cli/cli.mjs run infrastructure smtp2go maintain -- --skip-ip-allow-list
node apps/hdc-cli/cli.mjs run infrastructure smtp2go maintain -- --skip-allowed-senders
```

See [`docs/manually-deployed/smtp2go.md`](../../../docs/manually-deployed/smtp2go.md).
