# step-ca (`step-ca`)

Deploy Smallstep `step-ca` on Proxmox QEMU for internal certificate authority (ACME/API).

## Prerequisites

- **Config:** [`config.example.json`](config.example.json) → `config.json`
- **Inventory:** [`inventory/manual/systems/vm-step-ca-a.json`](../../../inventory/manual/systems/vm-step-ca-a.json); [`inventory/manual/services/step-ca.json`](../../../inventory/manual/services/step-ca.json)
- **Vault:** `HDC_STEP_CA_PASSWORD` (required); optional `HDC_STEP_CA_PASSWORD_A`

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | QEMU clone, `step ca init`, systemd under `/etc/step-ca` |
| `maintain` | Grow root disk when `rootfs_gb` exceeds live size; re-push `ca.json` and password file; optional package upgrade |
| `query` | CA service and health |

```bash
node apps/hdc-cli/cli.mjs run service step-ca deploy --
node apps/hdc-cli/cli.mjs run service step-ca maintain --
```

## Common flags

`--instance a`, `--destroy-existing`, `--skip-provision`, `--skip-install`, `--skip-existing`, `--skip-package-upgrade`, `--skip-disk-resize`, `--skip-clamav`, `--dry-run`.

Set `defaults.proxmox.qemu.rootfs_gb` (e.g. `16`) for deploy resize after clone and maintain growth on live guests.

## After deploy

1. **HTTPS:** step-ca listens on `step_ca.listen_address` (default `:443`) on the deployment IP — see `deployments[].configure.ssh.host` in config.
2. **Trust:** distribute `/etc/step-ca/certs/root_ca.crt` from the CA VM to clients that will talk to the ACME API or validate issued certs.
3. **ACME:** enabled when `step_ca.enable_acme` is true (default). Deploy runs `step ca init --acme`, which creates an ACME provisioner named `acme`.

## ACME client (certbot)

Use any ACMEv2 client against your private CA. Values below match [`config.example.json`](config.example.json).

### Directory URL

```
https://{step_ca.dns_names[0]}/acme/acme/directory
```

Example: `https://ca.hdc.example.invalid/acme/acme/directory`

Set `step_ca.enable_acme` to `false` before deploy to omit the ACME provisioner.

### Trust the root CA

ACME clients validate the CA over HTTPS using system trust stores. Copy the root cert from the CA VM and point certbot at it with `REQUESTS_CA_BUNDLE` (preferred for production). Alternatively, install it system-wide with `step certificate install` after bootstrapping the `step` CLI.

### Request a certificate

**Webroot** — when nginx or another web server already serves the hostname on port 80 (http-01 challenge):

```bash
# Copy root CA from the CA VM (after deploy)
scp root@192.0.2.24:/etc/step-ca/certs/root_ca.crt ./hdc-root-ca.crt

export REQUESTS_CA_BUNDLE="$PWD/hdc-root-ca.crt"
sudo -E certbot certonly -n \
  --webroot -w /var/www/html \
  -d app.hdc.example.invalid \
  --server https://ca.hdc.example.invalid/acme/acme/directory
```

**Standalone** — when nothing else is listening on port 80 (`sudo` required for http-01):

```bash
export REQUESTS_CA_BUNDLE="$PWD/hdc-root-ca.crt"
sudo -E certbot certonly -n --standalone \
  -d app.hdc.example.invalid \
  --server https://ca.hdc.example.invalid/acme/acme/directory
```

Replace `192.0.2.24`, `ca.hdc.example.invalid`, and `app.hdc.example.invalid` with your CA IP, `step_ca.dns_names[0]`, and the certificate hostname.

### Renewal

step-ca issues certificates with a much shorter default lifetime than Let's Encrypt (~24 hours). Schedule `certbot renew` more often (for example every 15 minutes via cron) and set `renew_before_expiry = 8 hours` in the certbot renewal config under `/etc/letsencrypt/renewal/`. See the [Smallstep ACME clients tutorial](https://smallstep.com/docs/tutorials/acme-protocol-acme-clients/) for details.

## Related

- [AGENTS.md — step-ca](../../../AGENTS.md)
- Schema: [`apps/hdc-cli/schema/step-ca.config.schema.json`](../../../apps/hdc-cli/schema/step-ca.config.schema.json)
- [Smallstep — Configure ACME clients with step-ca](https://smallstep.com/docs/tutorials/acme-protocol-acme-clients/)
