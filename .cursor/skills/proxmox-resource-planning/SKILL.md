---
name: proxmox-resource-planning
description: >-
  Plans CPU, memory, storage, and network allocation for new Proxmox VMs and
  LXC containers; checks cluster headroom and documents decisions in HDC
  inventory sidecars. Use when deploying or designing a new virtual service on
  Proxmox, sizing a VM/CT, choosing disks or bridges, or when the user mentions
  Proxmox capacity, overallocation, HA, backup space, or resource reservations.
disable-model-invocation: true
---

# Proxmox resource planning (HDC)

## Principles

1. **Measure before allocate**: Prefer live numbers from the Proxmox UI, `pvesh`, `pvesm status`, `zfs list`, or existing `query_last` in inventory over assumptions.
2. **Leave headroom**: The hypervisor needs RAM and I/O for ZFS ARC, Ceph, backups, migrations, and spikes. If numbers are unknown, call that out and list what to collect.
3. **Document in-repo**: Record durable decisions (node, pool, bridge, approximate sizing) in hdc-private `operations/inventory/{systems,networks,services,targets}/*.json` when tracked.

## 1. Classify the workload

| Kind | Typical Proxmox object | Extra considerations |
|------|------------------------|----------------------|
| Linux service / appliance | VM (cloud-init) or LXC | LXC shares the host kernel; lower overhead, less isolation than a VM |
| Windows or kernel-sensitive | VM | Full virtualization; plan virtio drivers and guest agent |
| Stateful DB / heavy I/O | VM on fast pool | Separate OS disk from data disk when possible; watch IOPS and sync writes |
| GPU / USB passthrough | VM | Reserve host resources; may affect migrations and HA |

## 2. Collect host and cluster facts (checklist)

Copy and fill from reality (inventory + user + node):

- **Nodes**: names, CPU model, **physical cores** (not just threads), SMT on/off
- **RAM**: installed GiB per node; current **used** vs **allocated** in Proxmox
- **Storage**: pool type (ZFS, LVM-thin, Ceph, NFS); redundancy; **free** space; whether backups share the same pool
- **Network**: bridge names, VLAN tags, uplink bandwidth, firewall zone intent
- **Policy**: allowed **vCPU:physical core** ratio, RAM overcommit OK or not, HA enabled, backup window and RPO

If any item is missing, state what is missing and how it changes risk (do not fabricate values).

## 3. CPU sizing

- Start from **expected sustained load**, not peak marketing specs.
- **Sockets vs cores**: Prefer **1 socket** and multiple cores unless guest licensing requires otherwise.
- **CPU limit / cpulimit** (optional): For noisy neighbors on shared nodes, consider a cap after baseline observation.
- **Type**: `host` can maximize performance but reduces live migration flexibility between mismatched hosts; `kvm64` (or cluster-default) is safer for heterogeneous clusters—note trade-offs explicitly.

**Sanity check**: Sum planned **new** vCPUs plus existing allocations against a **chosen** overcommit ratio (example only: some admins cap around **2:1** vCPU to physical core on mixed workloads; conservative services may target **≤1:1**). Adjust to the user's stated policy.

## 4. Memory sizing

- Include **guest OS overhead** and **application heap/cache**; leave **ballooning** off or conservative for DBs and latency-sensitive services unless there is a clear ops reason.
- Account for **Proxmox host reserve** (rule of thumb to validate per host: keep a **multi-GB** safety margin on small nodes; scale with ZFS/Ceph).
- If **hugepages** or **PCIe passthrough** are involved, verify compatible RAM reservation up front.

## 5. Storage sizing

- **OS disk**: smallish qcow2/raw on fast or default pool as appropriate.
- **Data disk**: size for data growth + **snapshot** + **backup** headroom; separate volumes when it simplifies backup and restore.
- **Disk bus**: `virtio-scsi` with **discard** where TRIM/discard matches the underlying pool policy.
- **I/O limits** (`mbps`, `iops`): Consider for multi-tenant nodes when latency matters.

Confirm **which storage ID** (`pvesm` / UI) and **format** (qcow2 vs raw vs ZFS vol) match backup and replication tooling in use.

## 6. Network

- Map the guest **bridge** and **VLAN tag** to documented inventory; do not invent bridge names.
- Note whether **firewall** rules live on Proxmox, the guest, or upstream L3.

## 7. HA, backup, and lifecycle

- **HA**: If the service joins HA groups, ensure **storage and network** are HA-compatible and quorum is understood.
- **Backups**: Destination space must cover retained generations; CPU/disk IO during backup windows competes with production.
- **Snapshots**: Frequent snapshots on busy write workloads need space and schedule planning.

## 8. Output template (for the user)

Use this structure in replies so decisions are auditable:

```markdown
## Proxmox allocation — [service name]

### Placement
- **Cluster / node**:
- **VMID / name** (if known):

### Compute
- **vCPU** (sockets × cores):
- **RAM (MiB)**:
- **CPU type / flags** (if non-default):

### Storage
| Role | Storage ID | Size | Format / notes |
|------|------------|------|----------------|
| OS   |            |      |                |
| Data |            |      |                |

### Network
- **Bridge / VLAN**:
- **Public vs internal** (intent):

### Headroom / risks
- **CPU / RAM / disk** remaining after this change (qualitative or numeric):
- **Open assumptions** (what still needs measurement):

### Repo follow-up
- **Inventory files to update** (hdc-private):
```

## 9. HDC repo hygiene

- After changing structured facts, validate inventory JSON against schemas under `../hdc/apps/hdc-cli/schema/`.
- Secrets stay in `.env` / vault; sidecars reference **env var names** only.

## Cross-links

- General CLI and inventory: [hdc AGENTS.md](../../../hdc/AGENTS.md)
- [.cursor/rules/proxmox-resource-planning.mdc](../../../.cursor/rules/proxmox-resource-planning.mdc)
