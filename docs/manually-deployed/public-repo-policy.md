# Public repo policy (hdc-clumps)

The **hdc-clumps** repository on GitHub is public package code (deploy/maintain/query scripts, examples, manifests). **Live operator data** belongs in the sibling private repo **hdc-private** (or any path set via `HDC_PRIVATE_ROOT` on the workstation running the hdc CLI).

The **hdc** repo holds the CLI (`apps/hdc-cli/`), shared package runtime (`hdc/package/*`), schemas, and agent fleet. Clone **hdc** and **hdc-clumps** as siblings, or set `HDC_CLUMPS_ROOT` to this directory.

## What belongs where

| Artifact | hdc-clumps (this repo) | hdc-private | Primary agent |
| --- | --- | --- | --- |
| Package scripts (`{clients,infrastructure,services}/**/`) | Yes | No | `hdc-sre-engineer` |
| `config.example.json`, structural JSON (zones, realms, split includes) | Yes | Optional copy | `hdc-sre-engineer` |
| `config.json` | **Never** | Yes (`services/<id>/config.json`, same relative path) | `hdc-sre-ops` |
| `.env` | Only `.env.example` | Yes | `hdc-sre-ops` |
| `operations/inventory/**`, `operations/automated/**` | **Never** | Yes | `hdc-sre-ops` |
| Deploy/maintain reports (`**/reports/`) | No (gitignored) | Yes | `hdc-sre-ops` |
| CLI, schemas, agent fleet (`apps/hdc-cli/`, `apps/hdc-agent-server/`) | No — [**hdc**](../hdc/README.md) | No | `hdc-engineer` |

Resolution order in the CLI: hdc-clumps (or `HDC_CLUMPS_ROOT`) for package code; hdc-private merge for `config.json` and `.env` on `hdc run`.

## Fictional fixtures in public examples

Use RFC 5737 documentation addresses and reserved example domains so published trees do not describe a real home LAN:

| Use | Example |
| --- | --- |
| LAN | `192.0.2.0/24` (`192.0.2.1` gateway, `192.0.2.2` DNS, …) |
| DNS zones | `example.invalid`, `hdc.example.invalid`, `home.example.invalid` |
| Operator email in docs/tests | `ops@example.invalid` |
| Extra brand domains in WAF examples | `brand-a.example`, `brand-b.example` |

Do not commit real hostnames, MAC addresses, VMIDs from production, or operator emails in the public repo.

## Never commit

- `config.json` (any package)
- `operations/**` or `inventory/**`
- `.env` (except `.env.example`)
- `vault.enc`, `*.pem`, `*.key`, `**/client_secret*.json`
- Operation reports under `**/reports/`

## If something leaks

1. Rotate any exposed credentials immediately.
2. Remove the file from HEAD and confirm CI/gitignore guards block re-add.
3. Purge from history with `git filter-repo` on the affected paths, then force-push after team notice.
4. Re-run `gitleaks detect --config .gitleaks.toml --source .` on the rewritten clone.

## Going public checklist

- [ ] CI `guard` and `secret-scan` workflows green
- [ ] No `10.0.0.x`, real domains, or private keys in tracked files
- [ ] GitHub secret scanning and push protection enabled on `dukk/hdc-clumps`
- [ ] **hdc-private** remains private and is not a submodule of hdc-clumps

## Related

- [hdc AGENTS.md](../hdc/AGENTS.md) — CLI reference, schemas, inventory conventions
- [hdc public-repo-policy](../hdc/docs/manually-deployed/public-repo-policy.md) — hdc repo policy
