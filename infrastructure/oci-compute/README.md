# Oracle Cloud compute (HDC)

HDC package `oci-compute` provisions **OCI VCN networking** (VCN, internet gateway, route table, subnet, NSG), **Compute VMs**, and **Container Instances**.

## Prerequisites

1. OCI tenancy with a target compartment.
2. API signing key for an IAM user with policies to manage virtual-network and compute resources in that compartment.
3. Repo `.env`: `HDC_OCI_TENANCY_OCID`, `HDC_OCI_USER_OCID`, `HDC_OCI_FINGERPRINT`, `HDC_OCI_REGION`
4. Vault: `HDC_OCI_API_PRIVATE_KEY` (PEM private key)
5. hdc-private `clumps/infrastructure/oci-compute/config.json` (seed from `config.example.json`)

Set region-specific `image_ocid` values per instance before deploy.

## Cost confirmation

Deploy and maintain (when creates are planned) show fallback monthly USD estimates on stderr and in operation reports. Prompts for confirmation unless `--yes`.

| Flag | Effect |
|------|--------|
| `--dry-run` | Estimate only |
| `--yes` | Skip prompt |
| `--accept-unknown-cost` | Proceed without a numeric estimate |

## Commands

```bash
node apps/hdc-cli/cli.mjs run infrastructure oci-compute query --
node apps/hdc-cli/cli.mjs run infrastructure oci-compute query -- --live
node apps/hdc-cli/cli.mjs run infrastructure oci-compute deploy -- --dry-run
node apps/hdc-cli/cli.mjs run infrastructure oci-compute deploy -- --resource a --yes
node apps/hdc-cli/cli.mjs run infrastructure oci-compute maintain --
node apps/hdc-cli/cli.mjs run infrastructure oci-compute teardown -- --resource a --yes
```

## Networking

OCI evaluates **both** subnet security lists and NSG rules — ingress must be allowed in each. `maintain` mirrors managed NSG TCP ingress rules onto public subnet security lists using each rule's `source` CIDR (not only `0.0.0.0/0`). Use per-rule `source` on `network_security_groups[].ingress[]` for operator-restricted ports (for example Uptime Kuma admin TCP 3001 from a home `/29`).

VMs receive operator `~/.ssh` public keys via instance metadata (`ssh_authorized_keys`).
