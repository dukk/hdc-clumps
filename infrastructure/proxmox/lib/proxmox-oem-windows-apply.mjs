import {
  buildOemLicenseProbeScript,
  normalizeOemTableRef,
  oemLicenseWarningsForHost,
  parseOemLicenseProbeOutput,
  summarizeOemLicenseHost,
} from "./proxmox-oem-windows-license.mjs";
import { pveFormBody, pveJsonRequest } from "./pve-http.mjs";
import {
  discoverLocalSshMaterial,
  shellSingleQuote,
  sshBashLc,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";

const SMBIOS_BEGIN = "HDC_SMBIOS_BEGIN";
const SMBIOS_END = "HDC_SMBIOS_END";

/**
 * @typedef {object} HostSmbiosFields
 * @property {string} uuid
 * @property {string} manufacturer
 * @property {string} product
 * @property {string} version
 * @property {string} serial
 * @property {string} sku
 * @property {string} family
 */

/**
 * @param {string} pveNode
 * @returns {string}
 */
export function buildOemTableDumpScript(pveNode) {
  const nodeQ = shellSingleQuote(pveNode);
  return `
set -e
NODE=${nodeQ}
QDIR="/etc/pve/nodes/$NODE/qemu-server"
mkdir -p "$QDIR"
DUMPED=""
if [ -r /sys/firmware/acpi/tables/MSDM ]; then
  cp /sys/firmware/acpi/tables/MSDM "$QDIR/MSDM_table"
  echo DUMPED_TABLE=MSDM_table
  DUMPED=1
fi
if [ -r /sys/firmware/acpi/tables/SLIC ]; then
  cp /sys/firmware/acpi/tables/SLIC "$QDIR/SLIC_table"
  echo DUMPED_TABLE=SLIC_table
  DUMPED=1
fi
if [ -z "$DUMPED" ]; then
  echo DUMPED_TABLE=none
fi
`.trim();
}

/**
 * @returns {string}
 */
export function buildHostSmbiosProbeScript() {
  return `
echo ${shellSingleQuote(SMBIOS_BEGIN)}
if command -v dmidecode >/dev/null 2>&1; then
  dmidecode -t 1 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      *UUID:*) echo "SMBIOS_UUID=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')" ;;
      *Manufacturer:*) echo "SMBIOS_MANUFACTURER=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')" ;;
      *Product\ Name:*) echo "SMBIOS_PRODUCT=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')" ;;
      *Version:*) echo "SMBIOS_VERSION=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')" ;;
      *Serial\ Number:*) echo "SMBIOS_SERIAL=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')" ;;
      *SKU\ Number:*) echo "SMBIOS_SKU=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')" ;;
      *Family:*) echo "SMBIOS_FAMILY=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')" ;;
    esac
  done
else
  echo SMBIOS_ERROR=dmidecode_missing
fi
echo ${shellSingleQuote(SMBIOS_END)}
`.trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeSmbiosValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,");
}

/**
 * @param {HostSmbiosFields} fields
 * @returns {string}
 */
export function formatSmbios1Param(fields) {
  const parts = [];
  if (fields.uuid) parts.push(`uuid=${escapeSmbiosValue(fields.uuid)}`);
  if (fields.manufacturer) parts.push(`manufacturer=${escapeSmbiosValue(fields.manufacturer)}`);
  if (fields.product) parts.push(`product=${escapeSmbiosValue(fields.product)}`);
  if (fields.version) parts.push(`version=${escapeSmbiosValue(fields.version)}`);
  if (fields.serial) parts.push(`serial=${escapeSmbiosValue(fields.serial)}`);
  if (fields.sku) parts.push(`sku=${escapeSmbiosValue(fields.sku)}`);
  if (fields.family) parts.push(`family=${escapeSmbiosValue(fields.family)}`);
  return parts.join(",");
}

/**
 * @param {string[]} tableFiles Absolute paths to ACPI table files on the hypervisor.
 * @returns {string}
 */
export function buildAcpitableArgs(tableFiles) {
  const files = tableFiles.filter(Boolean);
  if (!files.length) return "";
  return files.map((f) => `-acpitable file=${f}`).join(" ");
}

/**
 * @param {string} stdout
 * @returns {HostSmbiosFields}
 */
export function parseHostSmbiosOutput(stdout) {
  const text = String(stdout ?? "");
  const begin = text.indexOf(SMBIOS_BEGIN);
  const end = text.indexOf(SMBIOS_END);
  const block =
    begin >= 0 && end > begin ? text.slice(begin + SMBIOS_BEGIN.length, end) : text;

  /** @type {HostSmbiosFields} */
  const fields = {
    uuid: "",
    manufacturer: "",
    product: "",
    version: "",
    serial: "",
    sku: "",
    family: "",
  };

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("SMBIOS_ERROR=")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1).trim();
    if (key === "SMBIOS_UUID") fields.uuid = val;
    else if (key === "SMBIOS_MANUFACTURER") fields.manufacturer = val;
    else if (key === "SMBIOS_PRODUCT") fields.product = val;
    else if (key === "SMBIOS_VERSION") fields.version = val;
    else if (key === "SMBIOS_SERIAL") fields.serial = val;
    else if (key === "SMBIOS_SKU") fields.sku = val;
    else if (key === "SMBIOS_FAMILY") fields.family = val;
  }

  return fields;
}

/**
 * @param {string} pveNode
 * @param {string[]} dumpedTables
 * @returns {string[]}
 */
export function oemTablePathsForNode(pveNode, dumpedTables) {
  const base = `/etc/pve/nodes/${pveNode}/qemu-server`;
  return dumpedTables.map((t) => `${base}/${normalizeOemTableRef(t)}`);
}

/**
 * @param {object} opts
 * @param {import("hdc/cli/lib/ssh-host-access.mjs").SshTarget} opts.sshTarget
 * @param {string} opts.pveNode
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {(line: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.warn]
 * @param {boolean} [opts.dumpIfMissing]
 * @returns {Promise<{ ok: boolean; firmware: { msdm: boolean; slic: boolean }; dumpedTables: string[]; tablePaths: string[]; smbios: HostSmbiosFields; hostResult: import("./proxmox-oem-windows-license.mjs").OemLicenseHostResult }>}
 */
export async function prepareOemLicenseOnHost(opts) {
  const { sshTarget, pveNode, spawnSync, env, log = () => {}, warn = () => {} } = opts;
  const { identities } = discoverLocalSshMaterial();

  if (!sshReachableWithPubkey(sshTarget, spawnSync, env, identities)) {
    throw new Error(`SSH unreachable for ${sshTarget.id ?? "host"} (public-key auth failed)`);
  }

  const probeScript = buildOemLicenseProbeScript(pveNode);
  const probeR = sshBashLc(sshTarget, probeScript, {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 60_000,
  });
  if (probeR.status !== 0) {
    const err = `${probeR.stderr ?? ""}${probeR.stdout ?? ""}`.trim() || `ssh exit ${probeR.status ?? "?"}`;
    throw new Error(`OEM probe failed: ${err.slice(0, 500)}`);
  }

  let parsed = parseOemLicenseProbeOutput(`${probeR.stdout ?? ""}`, pveNode);

  if (
    opts.dumpIfMissing !== false &&
    (parsed.firmware.msdm || parsed.firmware.slic) &&
    parsed.dumpedTables.length === 0
  ) {
    log(`[${sshTarget.id}] dumping OEM ACPI tables to node ${pveNode} …`);
    const dumpR = sshBashLc(sshTarget, buildOemTableDumpScript(pveNode), {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 60_000,
    });
    if (dumpR.status !== 0) {
      const err = `${dumpR.stderr ?? ""}${dumpR.stdout ?? ""}`.trim() || `ssh exit ${dumpR.status ?? "?"}`;
      throw new Error(`OEM table dump failed: ${err.slice(0, 500)}`);
    }
    for (const rawLine of String(dumpR.stdout ?? "").split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("DUMPED_TABLE=")) {
        const name = line.slice("DUMPED_TABLE=".length).trim();
        if (name && name !== "none" && !parsed.dumpedTables.includes(name)) {
          parsed.dumpedTables.push(name);
        }
      }
    }
    const reprobe = sshBashLc(sshTarget, probeScript, {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 60_000,
    });
    if (reprobe.status === 0) {
      parsed = parseOemLicenseProbeOutput(`${reprobe.stdout ?? ""}`, pveNode);
    }
  }

  const smbiosR = sshBashLc(sshTarget, buildHostSmbiosProbeScript(), {
    spawnSync,
    env,
    mode: "pubkey",
    identities,
    timeoutMs: 60_000,
  });
  if (smbiosR.status !== 0) {
    const err = `${smbiosR.stderr ?? ""}${smbiosR.stdout ?? ""}`.trim() || `ssh exit ${smbiosR.status ?? "?"}`;
    throw new Error(`SMBIOS probe failed: ${err.slice(0, 500)}`);
  }
  const smbios = parseHostSmbiosOutput(`${smbiosR.stdout ?? ""}`);

  const hostResult = {
    hostId: sshTarget.id ?? pveNode,
    pveNode,
    clusterId: sshTarget.clusterId ?? null,
    firmware: parsed.firmware,
    dumpedTables: parsed.dumpedTables,
    assigned: parsed.assigned,
    status: "none",
    summary: "",
  };
  const { status, summary } = summarizeOemLicenseHost(hostResult);
  hostResult.status = status;
  hostResult.summary = summary;

  for (const w of oemLicenseWarningsForHost(hostResult)) {
    warn(w);
  }

  const tablePaths = oemTablePathsForNode(pveNode, parsed.dumpedTables);
  const hasFirmware = parsed.firmware.msdm || parsed.firmware.slic;

  return {
    ok: hasFirmware || parsed.dumpedTables.length > 0,
    firmware: parsed.firmware,
    dumpedTables: parsed.dumpedTables,
    tablePaths,
    smbios,
    hostResult,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string[]} opts.tablePaths
 * @param {HostSmbiosFields} opts.smbios
 * @param {number} [opts.exclusiveVmid] When set, refuse if another VM already has -acpitable
 * @param {(line: string) => void} [opts.log]
 */
export async function applyOemLicenseToVmConfig(opts) {
  const {
    apiBase,
    node,
    vmid,
    authorization,
    rejectUnauthorized,
    tablePaths,
    smbios,
    exclusiveVmid,
    log = () => {},
  } = opts;

  if (exclusiveVmid !== undefined && exclusiveVmid !== vmid) {
    throw new Error(
      `OEM license already assigned to VM ${exclusiveVmid}; only one Windows VM per host is supported`,
    );
  }

  /** @type {Record<string, string>} */
  const fields = {};
  const args = buildAcpitableArgs(tablePaths);
  if (args) fields.args = args;
  const smbios1 = formatSmbios1Param(smbios);
  if (smbios1) fields.smbios1 = smbios1;

  if (!Object.keys(fields).length) {
    log(`vmid ${vmid}: no OEM fields to apply`);
    return;
  }

  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;
  log(`Applying OEM passthrough on vmid ${vmid} (${node}) …`);
  await pveJsonRequest(
    "PUT",
    apiBase,
    path,
    authorization,
    rejectUnauthorized,
    pveFormBody(fields),
  );
}

/**
 * @param {object} opts
 * @param {import("hdc/cli/lib/ssh-host-access.mjs").SshTarget} opts.sshTarget
 * @param {string} opts.pveNode
 * @param {string} opts.apiBase
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {boolean} [opts.requireFirmware]
 * @param {(line: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.warn]
 */
export async function ensureOemLicenseForVm(opts) {
  const prepared = await prepareOemLicenseOnHost({
    sshTarget: opts.sshTarget,
    pveNode: opts.pveNode,
    spawnSync: opts.spawnSync,
    env: opts.env,
    log: opts.log,
    warn: opts.warn,
    dumpIfMissing: true,
  });

  const hasFirmware = prepared.firmware.msdm || prepared.firmware.slic;
  if (opts.requireFirmware && !hasFirmware && !prepared.dumpedTables.length) {
    throw new Error(
      `No MSDM/SLIC firmware table on ${opts.sshTarget.id ?? opts.pveNode}; OEM Windows license unavailable`,
    );
  }

  const otherAssigned = prepared.hostResult.assigned.filter((a) => a.vmid !== opts.vmid);
  if (otherAssigned.length) {
    const vmids = otherAssigned.map((a) => a.vmid).join(", ");
    throw new Error(
      `OEM license already assigned to VM(s) ${vmids} on ${opts.pveNode}; only one Windows VM per host`,
    );
  }

  if (!prepared.tablePaths.length && !formatSmbios1Param(prepared.smbios)) {
    opts.warn?.(`vmid ${opts.vmid}: no OEM tables or SMBIOS to apply`);
    return prepared;
  }

  await applyOemLicenseToVmConfig({
    apiBase: opts.apiBase,
    node: opts.node,
    vmid: opts.vmid,
    authorization: opts.authorization,
    rejectUnauthorized: opts.rejectUnauthorized,
    tablePaths: prepared.tablePaths,
    smbios: prepared.smbios,
    log: opts.log,
  });

  return prepared;
}
