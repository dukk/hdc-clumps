# AFFiNE (`affine`)

Self-hosted AFFiNE workspace on Proxmox LXC (Docker Compose: AFFiNE + Postgres/pgvector + Redis). LAN access defaults to `http://<ct-ip>:3010`.

## Config

- **Config:** [`config.example.json`](config.example.json) → `config.json` (hdc-private) — set `proxmox.host_id`, `proxmox.lxc.vmid`, static `ip_config`
- **Inventory:** `inventory/manual/systems/affine-a.json`; `inventory/manual/services/affine.json`
- **Vault:** `HDC_AFFINE_DB_PASSWORD` (auto-generated on first deploy/maintain if missing)
- **Mail (optional):** set `affine.mail.enabled` to push `MAILER_*` env via [postfix-relay](../postfix-relay/) `client_defaults` (no SMTP auth). Optional `affine.mail.from` (defaults to relay `default_from`).
- **Copilot / AI (optional):** set `affine.copilot.enabled` to write `$CONFIG_LOCATION/config.json` pointing at [LiteLLM](../litellm/) (`base_url` OpenAI-compatible `/v1`). Vault: `affine.copilot.api_key_vault_key` (default `HDC_LITELLM_MASTER_KEY`). Chat model: `affine.copilot.model` (LiteLLM `model_list` alias). Leave `indexer_enabled` false until an embedding model is available on LiteLLM.

## Commands

```bash
node apps/hdc-cli/cli.mjs run service affine deploy -- --instance a
node apps/hdc-cli/cli.mjs run service affine query -- --live
node apps/hdc-cli/cli.mjs run service affine maintain --
node apps/hdc-cli/cli.mjs run service affine teardown -- --instance a --yes
```

Deploy flags: `--skip-install`, `--skip-existing`, `--redeploy-existing`, `--instance`, `--system-id`.

Maintain flags: `--skip-upgrade`, `--skip-clamav`, guest baseline skip flags (see other LXC services).

## After deploy

1. Open `http://<ct-ip>:3010` from the LAN and create the first admin account in the web UI.
2. **Inventory:** set `access.nodes[0].ip` on `affine-a.json` from `query --live`.
3. **Backup:** preserve `HDC_AFFINE_DB_PASSWORD` and `/opt/affine/postgres` — do not change DB password or data paths after first start.
4. **Mail / AI:** enable `affine.mail` / `affine.copilot` in config, ensure LiteLLM master key is in vault, then `maintain`.
5. **HTTPS later:** set `affine.public_url`, add BIND + nginx-waf upstream with WebSockets enabled.

## References

- Schema: [`apps/hdc-cli/schema/affine.config.schema.json`](../../../apps/hdc-cli/schema/affine.config.schema.json)
- Upstream compose: [AFFiNE docker-compose.yml release](https://github.com/toeverything/affine/releases/latest/download/docker-compose.yml)
- Docs: [Self-host AFFiNE](https://docs.affine.pro/self-host-affine/), [AI](https://docs.affine.pro/self-host-affine/administer/ai), [environment variables](https://docs.affine.pro/self-host-affine/references/environment-variables)
