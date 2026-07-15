import { existsSync, readFileSync } from "node:fs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { join } from "node:path";

import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { findProxmoxHostInConfig, isProxmoxConfigObject } from "./proxmox-config.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import {
  discoverLocalSshMaterial,
  shellSingleQuote,
  sshBashLc,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";

const DEFAULT_EXTEND = {
  storageId: "local-lvm",
  vg: "pve",
  thinPool: "data",
};
const DEFAULT_EXTRA_CONTENT = "images,rootdir";

/**
 * @param {unknown} cfg
 */
export function localLvmMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const localLvm = provision.local_lvm;
  if (!isProxmoxConfigObject(localLvm)) return true;
  const extend = localLvm.extend;
  const extra = localLvm.extra_pools;
  const extendOn = !isProxmoxConfigObject(extend) || (extend.enabled !== false && extend.enabled !== 0);
  const extraOn = !isProxmoxConfigObject(extra) || (extra.enabled !== false && extra.enabled !== 0);
  return extendOn || extraOn;
}

/**
 * @param {unknown} cfg
 */
function provisionLocalLvm(cfg) {
  if (!isProxmoxConfigObject(cfg)) return null;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return null;
  const localLvm = provision.local_lvm;
  return isProxmoxConfigObject(localLvm) ? localLvm : null;
}

/**
 * @param {unknown} cfg
 */
export function localLvmExtendDefaultsFromConfig(cfg) {
  const localLvm = provisionLocalLvm(cfg);
  const extend = isProxmoxConfigObject(localLvm?.extend) ? localLvm.extend : {};
  return {
    storageId:
      typeof extend.storage_id === "string" && extend.storage_id.trim()
        ? extend.storage_id.trim()
        : DEFAULT_EXTEND.storageId,
    vg: typeof extend.vg === "string" && extend.vg.trim() ? extend.vg.trim() : DEFAULT_EXTEND.vg,
    thinPool:
      typeof extend.thin_pool === "string" && extend.thin_pool.trim()
        ? extend.thin_pool.trim()
        : DEFAULT_EXTEND.thinPool,
  };
}

/**
 * @param {unknown} cfg
 */
function globalExtendEnabled(cfg) {
  const localLvm = provisionLocalLvm(cfg);
  if (!isProxmoxConfigObject(localLvm?.extend)) return true;
  return localLvm.extend.enabled !== false && localLvm.extend.enabled !== 0;
}

/**
 * @param {unknown} cfg
 */
function globalExtraPoolsEnabled(cfg) {
  const localLvm = provisionLocalLvm(cfg);
  if (!isProxmoxConfigObject(localLvm?.extra_pools)) return true;
  return localLvm.extra_pools.enabled !== false && localLvm.extra_pools.enabled !== 0;
}

/**
 * @param {unknown} cfg
 */
export function localLvmExtraContentDefaultFromConfig(cfg) {
  const localLvm = provisionLocalLvm(cfg);
  const extra = isProxmoxConfigObject(localLvm?.extra_pools) ? localLvm.extra_pools : {};
  const c = typeof extra.content === "string" ? extra.content.trim() : "";
  return c || DEFAULT_EXTRA_CONTENT;
}

/**
 * @param {unknown} cfg
 * @param {string} hostId
 */
export function localLvmExtendEnabledForHost(cfg, hostId) {
  if (!globalExtendEnabled(cfg)) return false;
  const found = findProxmoxHostInConfig(cfg, hostId);
  if (!found) return false;
  const hostLl = found.host.local_lvm;
  if (!isProxmoxConfigObject(hostLl)) return true;
  if (hostLl.extend === false || hostLl.extend === 0) return false;
  if (hostLl.extend === true || hostLl.extend === 1) return true;
  return true;
}

/**
 * @typedef {object} LocalLvmPoolConfig
 * @property {string} storageId
 * @property {string} vg
 * @property {string} thinPool
 * @property {string} content
 * @property {string} mdName
 * @property {number} raidLevel
 * @property {string[]} devices
 */

/**
 * @param {unknown} cfg
 * @param {string} hostId
 * @returns {LocalLvmPoolConfig[]}
 */
export function localLvmPoolsForHost(cfg, hostId) {
  if (!globalExtraPoolsEnabled(cfg)) return [];
  const found = findProxmoxHostInConfig(cfg, hostId);
  if (!found) return [];
  const hostLl = found.host.local_lvm;
  if (!isProxmoxConfigObject(hostLl)) return [];
  const pools = hostLl.pools;
  if (!Array.isArray(pools)) return [];
  const defaultContent = localLvmExtraContentDefaultFromConfig(cfg);
  /** @type {LocalLvmPoolConfig[]} */
  const out = [];
  for (const p of pools) {
    if (!isProxmoxConfigObject(p)) continue;
    const storageId = typeof p.storage_id === "string" ? p.storage_id.trim() : "";
    const vg = typeof p.vg === "string" ? p.vg.trim() : "";
    const thinPool =
      typeof p.thin_pool === "string" && p.thin_pool.trim() ? p.thin_pool.trim() : "data";
    const raid = p.raid;
    if (!storageId || !vg || !isProxmoxConfigObject(raid)) continue;
    const level = raid.level;
    if (level !== 0) continue;
    const devices = Array.isArray(raid.devices)
      ? raid.devices.map((d) => String(d).trim()).filter(Boolean)
      : [];
    if (devices.length < 1) continue;
    const content =
      typeof p.content === "string" && p.content.trim() ? p.content.trim() : defaultContent;
    const mdName =
      typeof p.md_name === "string" && p.md_name.trim()
        ? p.md_name.trim()
        : vg.replace(/[^a-zA-Z0-9_-]+/g, "_");
    out.push({
      storageId,
      vg,
      thinPool,
      content,
      mdName,
      raidLevel: 0,
      devices,
    });
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.vg
 * @param {string} opts.thinPool
 * @param {string} opts.storageId
 * @returns {string}
 */
export function buildExtendLocalLvmScript(opts) {
  const { vg, thinPool, storageId } = opts;
  const qVg = shellSingleQuote(vg);
  const qThin = shellSingleQuote(thinPool);
  const qStorage = shellSingleQuote(storageId);
  return `
set -euo pipefail
VG=${qVg}
THIN=${qThin}
STORAGE_ID=${qStorage}
LV_PATH="/dev/\${VG}/\${THIN}"

echo "local-lvm extend: VG=\${VG} thin=\${THIN} storage=\${STORAGE_ID}"

if ! vgs "\${VG}" >/dev/null 2>&1; then
  echo "ERROR: volume group \${VG} not found"
  exit 1
fi
if ! lvs "\${LV_PATH}" >/dev/null 2>&1; then
  echo "ERROR: thin pool \${LV_PATH} not found"
  exit 1
fi

PV_COUNT=0
PV=""
while read -r pv_name vg_name; do
  [ "\${vg_name}" = "\${VG}" ] || continue
  PV_COUNT=$((PV_COUNT + 1))
  if [ -z "\${PV}" ]; then
    PV="\${pv_name}"
  fi
done < <(pvs --noheadings -o pv_name,vg_name 2>/dev/null || true)

if [ "\${PV_COUNT}" -gt 1 ]; then
  echo "SKIP: \${PV_COUNT} PVs on \${VG} — non-standard layout; extend manually"
  exit 0
fi

if [ -z "\${PV}" ]; then
  echo "ERROR: no physical volume for \${VG} (pvs -o pv_name,vg_name)"
  exit 1
fi

case "\${PV}" in
  /dev/nvme*n*p[0-9]*|/dev/mmcblk*p[0-9]*)
    DISK=$(echo "\${PV}" | sed -E 's/p[0-9]+\$//')
    PARTNUM=$(echo "\${PV}" | sed -E 's/.*p([0-9]+)\$/\\1/')
    ;;
  *)
    PKNAME=$(lsblk -no PKNAME "\${PV}" 2>/dev/null | head -1 || true)
    DISK="/dev/\${PKNAME}"
    PARTNUM=$(lsblk -no PARTN "\${PV}" 2>/dev/null | head -1 || true)
    if [ -z "\${PARTNUM}" ]; then
      PARTNUM=$(echo "\${PV}" | sed -n 's/^.*[^0-9]\\([0-9][0-9]*\\)\$/\\1/p')
    fi
    ;;
esac

if [ -z "\${DISK}" ] || [ "\${DISK}" = "/dev/" ] || [ -z "\${PARTNUM}" ]; then
  echo "ERROR: cannot resolve disk/partition for \${PV} (DISK=\${DISK} PARTNUM=\${PARTNUM})"
  exit 1
fi

echo "Resolved PV=\${PV} DISK=\${DISK} PARTNUM=\${PARTNUM}"
echo "BEFORE (PV \${PV} on \${DISK} partition \${PARTNUM}):"
pvs "\${PV}" 2>/dev/null || true
lvs "\${LV_PATH}" 2>/dev/null || true
command -v pvesm >/dev/null 2>&1 && pvesm status "\${STORAGE_ID}" 2>/dev/null || true

VG_FREE=$(vgs --noheadings -o vg_free --units m --nosuffix "\${VG}" 2>/dev/null | awk '{print int(\$1+0)}' || echo 0)
if [ "\${VG_FREE}" -gt 0 ]; then
  echo "VG \${VG} has \${VG_FREE} MiB free — extending thin pool \${THIN} (no partition grow)."
  lvextend -l +100%FREE "\${LV_PATH}"
  if lvs -a -o name "\${VG}" 2>/dev/null | grep -q '\\[data_tmeta\\]'; then
    lvresize --poolmetadatasize +512M "\${LV_PATH}" 2>/dev/null || true
  fi
  echo "AFTER:"
  pvs "\${PV}" 2>/dev/null || true
  lvs "\${LV_PATH}" 2>/dev/null || true
  command -v pvesm >/dev/null 2>&1 && pvesm status "\${STORAGE_ID}" 2>/dev/null || true
  echo "local-lvm extend: done (vg free space)"
  exit 0
fi

if ! command -v growpart >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "Installing cloud-guest-utils (growpart) …"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq cloud-guest-utils gdisk || {
      echo "ERROR: apt install cloud-guest-utils failed"
      exit 1
    }
  else
    echo "ERROR: growpart not installed (install cloud-guest-utils or gdisk)"
    exit 1
  fi
fi

GROW_OUT=$(growpart --dry-run "\${DISK}" "\${PARTNUM}" 2>&1) || true
if ! echo "\${GROW_OUT}" | grep -qE 'CHANGE|would be'; then
  echo "SKIP: no growable unallocated space after partition \${PARTNUM} on \${DISK}"
  echo "\${GROW_OUT}"
  exit 0
fi

echo "Growing partition \${DISK} \${PARTNUM} …"
set +e
GROW_OUT=$(growpart "\${DISK}" "\${PARTNUM}" 2>&1)
GP_STATUS=$?
set -e
if [ "\${GP_STATUS}" -eq 0 ]; then
  echo "\${GROW_OUT}"
elif echo "\${GROW_OUT}" | grep -qE 'NOCHANGE|not be grown|already the largest'; then
  echo "SKIP: \${GROW_OUT}"
  exit 0
elif [ "\${GP_STATUS}" -eq 2 ]; then
  echo "SKIP: growpart reported no change (exit 2)"
  exit 0
else
  echo "ERROR: growpart failed with exit \${GP_STATUS}: \${GROW_OUT}"
  exit 1
fi
pvresize "\${PV}"
lvextend -l +100%FREE "\${LV_PATH}"
if lvs -a -o name "\${VG}" 2>/dev/null | grep -q '\[data_tmeta\]'; then
  lvresize --poolmetadatasize +512M "\${LV_PATH}" 2>/dev/null || true
fi

echo "AFTER:"
pvs "\${PV}" 2>/dev/null || true
lvs "\${LV_PATH}" 2>/dev/null || true
command -v pvesm >/dev/null 2>&1 && pvesm status "\${STORAGE_ID}" 2>/dev/null || true
echo "local-lvm extend: done"
`.trim();
}

/**
 * @param {LocalLvmPoolConfig} pool
 * @returns {string}
 */
export function buildExtraPoolScript(pool) {
  const qStorage = shellSingleQuote(pool.storageId);
  const qVg = shellSingleQuote(pool.vg);
  const qThin = shellSingleQuote(pool.thinPool);
  const qContent = shellSingleQuote(pool.content);
  const qMd = shellSingleQuote(pool.mdName);
  const devLines = pool.devices.map((d) => `DEVICES+=(${shellSingleQuote(d)})`).join("\n");
  return `
set -euo pipefail
STORAGE_ID=${qStorage}
VG=${qVg}
THIN=${qThin}
CONTENT=${qContent}
MD_NAME=${qMd}
MD_DEV="/dev/md/\${MD_NAME}"
LV_PATH="/dev/\${VG}/\${THIN}"
DEVICES=()
${devLines}

echo "extra pool: storage=\${STORAGE_ID} vg=\${VG} devices=\${#DEVICES[@]}"

if command -v pvesm >/dev/null 2>&1 && pvesm status 2>/dev/null | awk '{print $1}' | grep -qxF "\${STORAGE_ID}"; then
  echo "Proxmox storage \${STORAGE_ID} already registered — skip."
  pvesm status "\${STORAGE_ID}" 2>/dev/null || true
  exit 0
fi

for d in "\${DEVICES[@]}"; do
  if [ ! -b "\${d}" ]; then
    echo "ERROR: device \${d} is not a block device"
    exit 1
  fi
  if findmnt -S "\${d}" -n -o TARGET 2>/dev/null | grep -q .; then
    echo "ERROR: device \${d} is mounted"
    exit 1
  fi
  if pvs "\${d}" 2>/dev/null | grep -q .; then
    vg_on_dev=$(pvs --noheadings -o vg_name "\${d}" 2>/dev/null | awk '{print $1}' | head -1 || true)
    if [ -n "\${vg_on_dev}" ] && [ "\${vg_on_dev}" = "\${VG}" ]; then
      echo "Device \${d} already PV in \${VG}"
    else
      echo "ERROR: device \${d} already has a physical volume in \${vg_on_dev:-unknown}"
      exit 1
    fi
  fi
done

PV_DEV=""
if [ "\${#DEVICES[@]}" -eq 1 ]; then
  PV_DEV="\${DEVICES[0]}"
  echo "Single-disk pool on \${PV_DEV}"
  if ! pvs "\${PV_DEV}" >/dev/null 2>&1 && ! vgs "\${VG}" >/dev/null 2>&1; then
    echo "wipefs -a \${PV_DEV} …"
    wipefs -a "\${PV_DEV}"
  fi
else
  if ! command -v mdadm >/dev/null 2>&1; then
    echo "Installing mdadm …"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq mdadm
  fi
  if ! mdadm --detail "\${MD_DEV}" >/dev/null 2>&1; then
    echo "Creating RAID0 array \${MD_DEV} …"
    for d in "\${DEVICES[@]}"; do
      echo "wipefs -a \${d} …"
      wipefs -a "\${d}"
    done
    mdadm --create "\${MD_DEV}" --level=0 --raid-devices=\${#DEVICES[@]} --name="\${MD_NAME}" "\${DEVICES[@]}"
  else
    echo "MD array \${MD_DEV} already exists"
    mdadm --detail "\${MD_DEV}" | head -5
  fi
  PV_DEV="\${MD_DEV}"
fi

if ! pvs "\${PV_DEV}" >/dev/null 2>&1; then
  echo "pvcreate \${PV_DEV} …"
  pvcreate -y "\${PV_DEV}"
else
  echo "PV on \${PV_DEV} already exists"
fi

if ! vgs "\${VG}" >/dev/null 2>&1; then
  echo "vgcreate \${VG} …"
  vgcreate "\${VG}" "\${PV_DEV}"
else
  echo "VG \${VG} already exists"
fi

if ! lvs "\${LV_PATH}" >/dev/null 2>&1; then
  echo "lvcreate thin pool \${LV_PATH} …"
  lvcreate -l 100%FREE -T -n "\${THIN}" "\${VG}"
else
  echo "Thin pool \${LV_PATH} already exists"
fi

if command -v pvesm >/dev/null 2>&1; then
  if pvesm status 2>/dev/null | awk '{print $1}' | grep -qxF "\${STORAGE_ID}"; then
    echo "Proxmox storage \${STORAGE_ID} already registered"
  else
    echo "pvesm add lvmthin \${STORAGE_ID} --vgname \${VG} --thinpool \${THIN} --content \${CONTENT} …"
    pvesm add lvmthin "\${STORAGE_ID}" --vgname "\${VG}" --thinpool "\${THIN}" --content "\${CONTENT}"
  fi
else
  echo "WARN: pvesm not found — register \${STORAGE_ID} manually"
fi

echo "extra pool: done"
pvesm status "\${STORAGE_ID}" 2>/dev/null || lvs "\${LV_PATH}" 2>/dev/null || true
`.trim();
}

/**
 * @param {{ user: string; host: string; id: string }} target
 * @param {string} script
 * @param {typeof import("node:child_process").spawnSync} spawnSync
 * @param {NodeJS.ProcessEnv} env
 * @param {{ privateKey: string; certificateFile?: string }[]} identities
 */
function runRemoteScript(target, script, spawnSync, env, identities) {
  return sshBashLc(target, script, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 600_000,
  });
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @returns {Promise<{ ok: boolean; results: Record<string, unknown>[] }>}
 */
export async function runProxmoxLocalLvmMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, env, spawnSync } = opts;
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Local LVM maintain");
  if (!loaded) {
    return { ok: true, results: [] };
  }
  const cfg = loaded.data;

  if (!localLvmMaintainEnabledFromConfig(cfg)) {
    log("local-lvm maintain: disabled in provision.local_lvm — skip.");
    return { ok: true, results: [] };
  }

  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  if (!targets.length) {
    warn("local-lvm maintain: no SSH targets — skip.");
    return { ok: true, results: [] };
  }

  const extendDefaults = localLvmExtendDefaultsFromConfig(cfg);
  const { identities } = discoverLocalSshMaterial();
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  log(`local-lvm maintain: ${targets.length} hypervisor(s)${dryRun ? " [dry-run]" : ""}.`);

  for (const target of targets) {
    /** @type {Record<string, unknown>} */
    const hostResult = { hostId: target.id };
    const doExtend = localLvmExtendEnabledForHost(cfg, target.id);
    const pools = localLvmPoolsForHost(cfg, target.id);

    if (!doExtend && !pools.length) {
      log(`[${target.id}] local-lvm: nothing configured — skip.`);
      hostResult.skipped = true;
      results.push(hostResult);
      continue;
    }

    if (!dryRun && !sshReachableWithPubkey(target, spawnSync, env, identities)) {
      ok = false;
      warn(
        `[${target.id}] SSH public-key auth failed — run maintain without --skip-ssh-keys first.`,
      );
      hostResult.ok = false;
      hostResult.error = "ssh unreachable";
      results.push(hostResult);
      continue;
    }

    if (doExtend) {
      const script = buildExtendLocalLvmScript(extendDefaults);
      log(
        `[${target.id}] extend ${extendDefaults.vg}/${extendDefaults.thinPool} (${extendDefaults.storageId}) …`,
      );
      if (dryRun) {
        log(`[${target.id}] dry-run extend script:\n${script}`);
        hostResult.extend = { dryRun: true, ok: true };
      } else {
        const r = runRemoteScript(target, script, spawnSync, env, identities);
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
        const skipped = /SKIP:/.test(out);
        const extendOk = r.status === 0;
        if (!extendOk) ok = false;
        if (!extendOk) {
          const tail = out ? out.split("\n").slice(-40).join("\n") : "";
          warn(
            `[${target.id}] extend failed (status ${r.status ?? "?"}): ${tail || "no output"}`,
          );
        } else if (skipped) {
          log(`[${target.id}] extend: ${out.split("\n")[0] || "skipped"}`);
        } else {
          log(`[${target.id}] extend finished.`);
        }
        hostResult.extend = { ok: extendOk, skipped, output: out.slice(0, 2000) };
      }
    }

    if (pools.length) {
      /** @type {Record<string, unknown>[]} */
      const poolResults = [];
      for (const pool of pools) {
        const poolLabel =
          pool.devices.length === 1
            ? `single disk`
            : `RAID${pool.raidLevel}, ${pool.devices.length} disks`;
        log(`[${target.id}] extra pool ${pool.storageId} (${poolLabel}) …`);
        const script = buildExtraPoolScript(pool);
        if (dryRun) {
          log(`[${target.id}] dry-run pool ${pool.storageId}:\n${script}`);
          poolResults.push({ storageId: pool.storageId, dryRun: true, ok: true });
          continue;
        }
        const r = runRemoteScript(target, script, spawnSync, env, identities);
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
        const poolOk = r.status === 0;
        if (!poolOk) {
          ok = false;
          warn(
            `[${target.id}] pool ${pool.storageId} failed (status ${r.status ?? "?"}): ${out || "no output"}`,
          );
        } else {
          log(`[${target.id}] pool ${pool.storageId} finished.`);
        }
        poolResults.push({
          storageId: pool.storageId,
          ok: poolOk,
          output: out.slice(0, 2000),
        });
      }
      hostResult.pools = poolResults;
    }

    results.push(hostResult);
  }

  if (ok) log("local-lvm maintain finished.");
  else log("local-lvm maintain finished with errors — see warnings.");

  return { ok, results };
}
