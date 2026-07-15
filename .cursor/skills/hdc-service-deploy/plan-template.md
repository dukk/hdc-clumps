# Deploy plan: {{service_id}} (instance {{instance}})

**Created:** {{date}}  
**Status:** Draft — **do not run deploy until approved below**

---

## 1. Summary

| Field | Value |
|-------|-------|
| Service package | `{{service_id}}` |
| Instance | `{{instance}}` (`{{system_id}}`) |
| Deploy backend | `{{mode}}` (e.g. `proxmox-lxc`, `proxmox-qemu`, `synology-docker`, `configure-only`) |
| Target host | `{{proxmox_host_id}}` / `{{synology_instance}}` |
| Access | {{lan_only_or_public}} |

---

## 2. Network

| Field | Value |
|-------|-------|
| IP group | `{{ip_group}}` (from `hdc-private/operations/ip-allocations.md`) |
| Static IP (CIDR) | `{{ip_cidr}}` |
| Gateway | `{{gateway}}` |
| Bridge | `{{bridge}}` |
| DNS hostname | `{{hostname}}` |
| Service port | `{{host_port}}` |
| BIND A record | {{planned_or_existing}} |

Cross-check chosen IP against BIND and inventory before approval.

---

## 3. Sizing (Proxmox)

| Resource | Planned | Notes |
|----------|---------|-------|
| vCPU / cores | {{cores}} | See proxmox-resource-planning skill if estimated |
| RAM (MiB) | {{memory_mb}} | |
| Root disk (GiB) | {{rootfs_gb}} | |
| Data disk | {{data_disk_or_none}} | |

---

## 3b. Cost estimate (cloud backends only)

When `mode` is `azure-vm`, `azure-aci`, `gcp-vm`, or `gcp-cloud-run`:

| Field | Value |
|-------|-------|
| Pricing source | {{azure_retail_or_gcp_fallback}} |
| Estimated monthly (USD) | {{cost_monthly_usd}} |
| Confirmed in plan? | Run `hdc run infrastructure <azure\|gcp-compute> deploy -- --section compute --dry-run` and paste summary |

Operator must approve cost line in **Section 10** before non–dry-run cloud deploy.

---

## 4. Files to create or change

| Path (repo) | Action |
|-------------|--------|
| `hdc-private/services/{{service_id}}/config.json` | {{create_or_update}} |
| `hdc-private/operations/inventory/systems/{{system_id}}.json` | {{create_or_update}} |
| `hdc-private/operations/inventory/services/{{service_id}}.json` | {{create_or_update}} |
| `services/{{service_id}}/*` (hdc-clumps) | {{only_if_scaffolding_or_script_fix}} |

---

## 5. Secrets (names only — no values)

| Vault key | Required | Set before deploy? |
|-----------|----------|-------------------|
| {{vault_keys_table}} | | |

```bash
# Run only after approval; values entered interactively (masked).
hdc secrets set {{VAULT_KEY}}
```

---

## 6. Deploy commands (ordered)

Run from **hdc repo root** (`../hdc`) after approval.

```bash
# Optional: ensure private config exists
node apps/hdc-cli/scripts/bootstrap-hdc-private-configs.mjs

# Pre-flight (read-only)
hdc run service {{service_id}} query --

# Deploy
hdc run service {{service_id}} deploy -- {{deploy_flags}}
```

**Deploy flags for this run:** `{{deploy_flags}}`

---

## 7. Dependencies (optional — unchecked until you confirm)

Only run steps you explicitly approve. Upstream URLs must come from deploy/query output, not guesses.

- [ ] **synology-nas** maintain (before Synology Docker stacks)
- [ ] **bind** maintain — forward A record for `{{dns_name}}` → `{{ip}}`
- [ ] **nginx-waf** or **nginx** maintain — site `{{site_id}}` → `http://{{guest_ip}}:{{port}}`
- [ ] **cloudflare** maintain — public A/CNAME for `{{public_hostname}}`
- [ ] **nagios** maintain — after BIND A record exists

```bash
# Example (fill after guest IP is known):
# hdc run service bind maintain --
# hdc run service nginx-waf maintain -- --site {{site_id}}
# hdc run infrastructure cloudflare maintain -- --zone {{zone}}
# hdc run service nagios maintain --
```

---

## 8. Validation

```bash
hdc run service {{service_id}} query -- --live
```

- [ ] Guest reachable at planned IP
- [ ] HTTP/service health OK
- [ ] Inventory `access.nodes[].ip` and `web_ui` updated
- [ ] Operation report reviewed: `hdc-private/services/{{service_id}}/reports/deploy-*.md`

---

## 9. Rollback

```bash
hdc run service {{service_id}} teardown -- --instance {{instance}} --dry-run
# After review:
# hdc run service {{service_id}} teardown -- --instance {{instance}} --yes
```

Proxmox destroy flags (if applicable): `{{destroy_existing_notes}}`

---

## 10. Approval

**The agent must not run deploy or dependency maintain commands until you reply.**

- [ ] I approve this plan as written
- [ ] I approve deploy only (dependencies later)
- [ ] I approve deploy + checked dependency items in section 7

**Approver:** _____________ **Date:** _____________

**Revision notes (if any):**
