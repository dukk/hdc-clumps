/**
 * OS-aware disk / updates / package / hardware ops via MeshCentral runcommands.
 */
import { runOnDevice } from "./meshcentral-runcommand.mjs";

/**
 * @param {"windows" | "linux" | "unknown" | string} platform
 */
export function diskCommand(platform) {
  if (platform === "windows") {
    return (
      "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | " +
      "Select-Object DeviceID,@{N='SizeGB';E={[math]::Round($_.Size/1GB,2)}},@{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,2)}},@{N='UsedPct';E={if($_.Size){[math]::Round(100*($_.Size-$_.FreeSpace)/$_.Size,1)}else{0}}} | " +
      "ConvertTo-Json -Compress"
    );
  }
  return "df -hP / /home /var 2>/dev/null || df -hP";
}

/**
 * Remote command that prints a single JSON object with system/cpu/memory/disk/gpu/mac.
 * @param {"windows" | "linux" | "unknown" | string} platform
 */
export function hardwareCommand(platform) {
  if (platform === "windows") {
    return (
      "$ErrorActionPreference='Stop'; " +
      "$cs=Get-CimInstance Win32_ComputerSystem; " +
      "$bios=Get-CimInstance Win32_BIOS; " +
      "$cpu=@(Get-CimInstance Win32_Processor)[0]; " +
      "$nic=@(Get-CimInstance Win32_NetworkAdapterConfiguration | " +
      "Where-Object { $_.IPEnabled -eq $true -and $_.MACAddress })[0]; " +
      "$disks=@(Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | " +
      "ForEach-Object { [pscustomobject]@{ device=$_.DeviceID; " +
      "size_gb=[math]::Round(($_.Size/1GB),2); free_gb=[math]::Round(($_.FreeSpace/1GB),2) } }); " +
      "$gpus=@(); " +
      "$nvsmi=Get-Command nvidia-smi -ErrorAction SilentlyContinue; " +
      "if ($nvsmi) { " +
      "  $nv=(& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null); " +
      "  if ($nv) { " +
      "    foreach ($line in @($nv)) { " +
      "      $p=($line -split ',',2); if ($p.Count -lt 2) { continue }; " +
      "      $nm=$p[0].Trim(); $mb=0; [void][double]::TryParse($p[1].Trim(),[ref]$mb); " +
      "      if ($nm) { $gpus += [pscustomobject]@{ name=$nm; vram_mb=[int][math]::Round($mb) } } " +
      "    } " +
      "  } " +
      "}; " +
      "if (-not $gpus.Count) { " +
      "  $gpus=@(Get-CimInstance Win32_VideoController | " +
      "    Where-Object { $_.Name -and ($_.Name -notmatch 'Basic Display|Microsoft Remote|Remote Desktop|Microsoft Basic') } | " +
      "    ForEach-Object { " +
      "      $vram=$null; if ($_.AdapterRAM -and $_.AdapterRAM -gt 0) { " +
      "        $vram=[int][math]::Round(([uint64]([uint32]$_.AdapterRAM))/1MB) }; " +
      "      [pscustomobject]@{ name=$_.Name; vram_mb=$vram } " +
      "    }) " +
      "}; " +
      "[pscustomobject]@{ " +
      "manufacturer=$cs.Manufacturer; model=$cs.Model; serial=$bios.SerialNumber; " +
      "cpu_model=$cpu.Name; logical_cores=[int]$cs.NumberOfLogicalProcessors; " +
      "memory_gb=[math]::Round(($cs.TotalPhysicalMemory/1GB),2); " +
      "mac=$(if($nic){$nic.MACAddress}else{$null}); disks=$disks; gpus=$gpus " +
      "} | ConvertTo-Json -Compress -Depth 5"
    );
  }
  // Linux: emit JSON via python3 when available; else minimal shell JSON.
  return (
    "python3 - <<'PY'\n" +
    "import json, os, re, glob, shutil, subprocess\n" +
    "def r(p):\n" +
    "  try:\n" +
    "    return open(p).read().strip()\n" +
    "  except Exception:\n" +
    "    return ''\n" +
    "manuf=r('/sys/class/dmi/id/sys_vendor') or r('/sys/devices/virtual/dmi/id/sys_vendor')\n" +
    "model=r('/sys/class/dmi/id/product_name') or r('/sys/devices/virtual/dmi/id/product_name')\n" +
    "serial=r('/sys/class/dmi/id/product_serial') or r('/sys/devices/virtual/dmi/id/product_serial')\n" +
    "cpu_model=''\n" +
    "for line in open('/proc/cpuinfo'):\n" +
    "  if line.startswith('model name') or line.startswith('Hardware'):\n" +
    "    cpu_model=line.split(':',1)[1].strip(); break\n" +
    "cores=0\n" +
    "try:\n" +
    "  cores=len(os.sched_getaffinity(0))\n" +
    "except Exception:\n" +
    "  cores=sum(1 for line in open('/proc/cpuinfo') if line.startswith('processor'))\n" +
    "mem_kb=0\n" +
    "for line in open('/proc/meminfo'):\n" +
    "  if line.startswith('MemTotal:'):\n" +
    "    mem_kb=int(line.split()[1]); break\n" +
    "disks=[]\n" +
    "for path in ('/','/home','/var'):\n" +
    "  try:\n" +
    "    st=os.statvfs(path)\n" +
    "    size=st.f_frsize*st.f_blocks; free=st.f_frsize*st.f_bavail\n" +
    "    disks.append({'device':path,'size_gb':round(size/1e9,2),'free_gb':round(free/1e9,2)})\n" +
    "  except Exception:\n" +
    "    pass\n" +
    "mac=''\n" +
    "for iface in sorted(glob.glob('/sys/class/net/*')):\n" +
    "  name=os.path.basename(iface)\n" +
    "  if name=='lo' or name.startswith(('docker','veth','br','virbr','cni')): continue\n" +
    "  addr=r(os.path.join(iface,'address'))\n" +
    "  if addr and addr!='00:00:00:00:00:00':\n" +
    "    mac=addr; break\n" +
    "gpus=[]\n" +
    "nvsmi=shutil.which('nvidia-smi')\n" +
    "if nvsmi:\n" +
    "  try:\n" +
    "    out=subprocess.check_output([nvsmi,'--query-gpu=name,memory.total','--format=csv,noheader,nounits'],text=True,stderr=subprocess.DEVNULL,timeout=15)\n" +
    "    for line in out.splitlines():\n" +
    "      parts=[p.strip() for p in line.split(',',1)]\n" +
    "      if len(parts)<2 or not parts[0]: continue\n" +
    "      try: mb=int(round(float(parts[1])))\n" +
    "      except Exception: mb=None\n" +
    "      gpus.append({'name':parts[0],'vram_mb':mb})\n" +
    "  except Exception:\n" +
    "    pass\n" +
    "if not gpus and shutil.which('lspci'):\n" +
    "  try:\n" +
    "    out=subprocess.check_output(['lspci'],text=True,stderr=subprocess.DEVNULL,timeout=15)\n" +
    "    for line in out.splitlines():\n" +
    "      if re.search(r'VGA compatible controller|3D controller|Display controller', line, re.I):\n" +
    "        name=re.sub(r'^[0-9a-f:.]+\\s+[^:]+:\\s*','',line,flags=re.I).strip()\n" +
    "        if name: gpus.append({'name':name,'vram_mb':None})\n" +
    "  except Exception:\n" +
    "    pass\n" +
    "print(json.dumps({'manufacturer':manuf,'model':model,'serial':serial,'cpu_model':cpu_model," +
    "'logical_cores':cores,'memory_gb':round(mem_kb/1048576,2),'mac':mac or None,'disks':disks,'gpus':gpus}))\n" +
    "PY"
  );
}

/**
 * Normalize MAC to lowercase colon-separated form, or null if invalid.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeHardwareMac(raw) {
  if (typeof raw !== "string") return null;
  const hex = raw.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  if (/^0+$/.test(hex)) return null;
  return hex.match(/.{2}/g)?.join(":") ?? null;
}

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Extract first JSON object/array from agent stdout (may include banners).
 * @param {string} text
 * @returns {unknown | null}
 */
export function extractJsonPayload(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const startObj = s.indexOf("{");
  const startArr = s.indexOf("[");
  let start = -1;
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj;
  else if (startArr >= 0) start = startArr;
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth += 1;
    else if (s[i] === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parse hardware command stdout into inventory `hardware[]` + optional mac.
 * @param {string} output
 * @returns {{ ok: true; hardware: Record<string, unknown>[]; mac: string | null } | { ok: false; message: string }}
 */
export function parseHardwareOutput(output) {
  const payload = extractJsonPayload(output);
  if (!isObject(payload)) {
    return { ok: false, message: "hardware output is not JSON object" };
  }
  /** @type {Record<string, unknown>[]} */
  const hardware = [];
  const manufacturer = typeof payload.manufacturer === "string" ? payload.manufacturer.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const serial = typeof payload.serial === "string" ? payload.serial.trim() : "";
  if (manufacturer || model || serial) {
    /** @type {Record<string, unknown>} */
    const sys = { type: "system" };
    if (manufacturer) sys.manufacturer = manufacturer;
    if (model) sys.model = model;
    if (serial && !/^none$/i.test(serial) && !/^0+$/.test(serial)) sys.serial = serial;
    hardware.push(sys);
  }
  const cpuModel = typeof payload.cpu_model === "string" ? payload.cpu_model.trim() : "";
  const coresRaw = payload.logical_cores;
  const cores =
    typeof coresRaw === "number"
      ? coresRaw
      : typeof coresRaw === "string"
        ? Number(coresRaw)
        : NaN;
  if (cpuModel || Number.isFinite(cores)) {
    /** @type {Record<string, unknown>} */
    const cpu = { type: "cpu" };
    if (cpuModel) cpu.model = cpuModel;
    if (Number.isFinite(cores) && cores > 0) cpu.logical_cores = Math.round(cores);
    hardware.push(cpu);
  }
  const memRaw = payload.memory_gb;
  const mem =
    typeof memRaw === "number" ? memRaw : typeof memRaw === "string" ? Number(memRaw) : NaN;
  if (Number.isFinite(mem) && mem > 0) {
    hardware.push({ type: "memory", total_gb: Math.round(mem * 100) / 100 });
  }
  const gpus = Array.isArray(payload.gpus) ? payload.gpus : [];
  for (const g of gpus) {
    if (!isObject(g)) continue;
    const gpuName =
      typeof g.name === "string"
        ? g.name.trim()
        : typeof g.model === "string"
          ? g.model.trim()
          : "";
    if (!gpuName) continue;
    /** @type {Record<string, unknown>} */
    const gpu = { type: "gpu", model: gpuName };
    const vramRaw = g.vram_mb ?? g.vram_MB ?? g.memory_mb;
    const vram =
      typeof vramRaw === "number" ? vramRaw : typeof vramRaw === "string" ? Number(vramRaw) : NaN;
    if (Number.isFinite(vram) && vram > 0) gpu.vram_mb = Math.round(vram);
    hardware.push(gpu);
  }
  const disks = Array.isArray(payload.disks) ? payload.disks : [];
  for (const d of disks) {
    if (!isObject(d)) continue;
    const device = typeof d.device === "string" ? d.device.trim() : typeof d.DeviceID === "string" ? d.DeviceID.trim() : "";
    const size =
      typeof d.size_gb === "number"
        ? d.size_gb
        : typeof d.SizeGB === "number"
          ? d.SizeGB
          : Number(d.size_gb ?? d.SizeGB);
    const free =
      typeof d.free_gb === "number"
        ? d.free_gb
        : typeof d.FreeGB === "number"
          ? d.FreeGB
          : Number(d.free_gb ?? d.FreeGB);
    if (!device) continue;
    /** @type {Record<string, unknown>} */
    const disk = { type: "disk", device };
    if (Number.isFinite(size) && size >= 0) disk.size_gb = Math.round(size * 100) / 100;
    if (Number.isFinite(free) && free >= 0) disk.free_gb = Math.round(free * 100) / 100;
    hardware.push(disk);
  }
  if (!hardware.length) {
    return { ok: false, message: "hardware JSON contained no usable fields" };
  }
  return { ok: true, hardware, mac: normalizeHardwareMac(payload.mac) };
}

/**
 * @param {"windows" | "linux" | "unknown" | string} platform
 */
export function updatesCommand(platform) {
  if (platform === "windows") {
    return (
      "$ErrorActionPreference='Continue'; " +
      "if (Get-Module -ListAvailable PSWindowsUpdate) { " +
      "Import-Module PSWindowsUpdate; Install-WindowsUpdate -AcceptAll -IgnoreReboot | Out-String " +
      "} else { " +
      "winget upgrade --all --accept-package-agreements --accept-source-agreements 2>&1 | Out-String " +
      "}"
    );
  }
  return "export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get dist-upgrade -y";
}

/**
 * @param {"windows" | "linux" | "unknown" | string} platform
 * @param {string} pkg
 */
export function installCommand(platform, pkg) {
  const p = String(pkg || "").trim();
  if (!p) throw new Error("package name required for --install");
  if (platform === "windows") {
    const q = p.replace(/"/g, '`"');
    return `winget install -e --id "${q}" --accept-package-agreements --accept-source-agreements 2>&1; if ($LASTEXITCODE -ne 0) { winget install -e --name "${q}" --accept-package-agreements --accept-source-agreements 2>&1 }`;
  }
  // shell-escape single quotes for apt
  const safe = p.replace(/'/g, `'\\''`);
  return `export DEBIAN_FRONTEND=noninteractive; apt-get install -y '${safe}'`;
}

/**
 * @param {"windows" | "linux" | "unknown" | string} platform
 * @param {string} pkg
 */
export function removeCommand(platform, pkg) {
  const p = String(pkg || "").trim();
  if (!p) throw new Error("package name required for --remove");
  if (platform === "windows") {
    const q = p.replace(/"/g, '`"');
    return `winget uninstall -e --id "${q}" 2>&1; if ($LASTEXITCODE -ne 0) { winget uninstall -e --name "${q}" 2>&1 }`;
  }
  const safe = p.replace(/'/g, `'\\''`);
  return `export DEBIAN_FRONTEND=noninteractive; apt-get remove -y '${safe}'`;
}

/**
 * Probe platform when unknown.
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {string} nodeId
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 * @returns {Promise<"windows" | "linux" | "unknown">}
 */
export async function detectPlatform(client, nodeId, opts = {}) {
  if (opts.dryRun) return "unknown";
  const r = await runOnDevice(client, nodeId, "uname -s 2>/dev/null || ver", {
    platform: "linux",
    log: opts.log,
    timeoutMs: 30_000,
  });
  const out = (r.output || "").toLowerCase();
  if (out.includes("linux") || out.includes("darwin")) return "linux";
  if (out.includes("windows") || out.includes("microsoft")) return "windows";
  // Retry as PowerShell
  const r2 = await runOnDevice(client, nodeId, "$PSVersionTable.PSVersion.ToString()", {
    platform: "windows",
    log: opts.log,
    timeoutMs: 30_000,
  });
  if (r2.ok && r2.output && !/error|not recognized/i.test(r2.output)) return "windows";
  return "unknown";
}

/**
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {Record<string, unknown>} device resolved device row
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function collectDisk(client, device, opts = {}) {
  const nodeId = typeof device.node_id === "string" ? device.node_id : "";
  if (!nodeId) return { ok: false, message: "missing node_id" };
  let platform = String(device.platform || "unknown");
  if (platform === "unknown" && !opts.dryRun) {
    platform = await detectPlatform(client, nodeId, opts);
  }
  const cmd = diskCommand(platform);
  const result = await runOnDevice(client, nodeId, cmd, {
    platform,
    dryRun: opts.dryRun,
    log: opts.log,
    timeoutMs: 60_000,
  });
  return {
    ok: result.ok,
    platform,
    output: result.output,
    dry_run: result.dry_run === true,
  };
}

/**
 * Collect CPU/RAM/disk/system identity (+ MAC) from an online agent.
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {Record<string, unknown>} device
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 * @returns {Promise<{
 *   ok: boolean;
 *   platform?: string;
 *   hardware?: Record<string, unknown>[];
 *   mac?: string | null;
 *   output?: string;
 *   message?: string;
 *   dry_run?: boolean;
 * }>}
 */
export async function collectHardware(client, device, opts = {}) {
  const nodeId = typeof device.node_id === "string" ? device.node_id : "";
  if (!nodeId) return { ok: false, message: "missing node_id" };
  let platform = String(device.platform || "unknown");
  if (platform === "unknown" && !opts.dryRun) {
    platform = await detectPlatform(client, nodeId, opts);
  }
  if (platform === "unknown") {
    return { ok: false, message: "cannot determine platform for hardware collect", platform };
  }
  const cmd = hardwareCommand(platform);
  const result = await runOnDevice(client, nodeId, cmd, {
    platform,
    dryRun: opts.dryRun,
    log: opts.log,
    timeoutMs: 90_000,
  });
  if (opts.dryRun) {
    return { ok: true, platform, hardware: [], mac: null, dry_run: true, output: "" };
  }
  if (!result.ok) {
    return {
      ok: false,
      platform,
      message: "hardware runcommand failed",
      output: result.output,
    };
  }
  const parsed = parseHardwareOutput(result.output || "");
  if (!parsed.ok) {
    return {
      ok: false,
      platform,
      message: parsed.message,
      output: result.output,
    };
  }
  return {
    ok: true,
    platform,
    hardware: parsed.hardware,
    mac: parsed.mac,
    output: result.output,
  };
}

/**
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {Record<string, unknown>} device
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function runOsUpdates(client, device, opts = {}) {
  const nodeId = typeof device.node_id === "string" ? device.node_id : "";
  if (!nodeId) return { ok: false, message: "missing node_id" };
  let platform = String(device.platform || "unknown");
  if (platform === "unknown" && !opts.dryRun) {
    platform = await detectPlatform(client, nodeId, opts);
  }
  if (platform === "unknown") {
    return { ok: false, message: "cannot determine platform for updates" };
  }
  const result = await runOnDevice(client, nodeId, updatesCommand(platform), {
    platform,
    dryRun: opts.dryRun,
    log: opts.log,
    timeoutMs: 600_000,
  });
  return { ok: result.ok, platform, output: result.output, dry_run: result.dry_run === true };
}

/**
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {Record<string, unknown>} device
 * @param {string} pkg
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function installPackage(client, device, pkg, opts = {}) {
  const nodeId = typeof device.node_id === "string" ? device.node_id : "";
  if (!nodeId) return { ok: false, message: "missing node_id" };
  let platform = String(device.platform || "unknown");
  if (platform === "unknown" && !opts.dryRun) {
    platform = await detectPlatform(client, nodeId, opts);
  }
  if (platform === "unknown") {
    return { ok: false, message: "cannot determine platform for install" };
  }
  const result = await runOnDevice(client, nodeId, installCommand(platform, pkg), {
    platform,
    dryRun: opts.dryRun,
    log: opts.log,
    timeoutMs: 600_000,
  });
  return { ok: result.ok, platform, package: pkg, output: result.output, dry_run: result.dry_run === true };
}

/**
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {Record<string, unknown>} device
 * @param {string} pkg
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function removePackage(client, device, pkg, opts = {}) {
  const nodeId = typeof device.node_id === "string" ? device.node_id : "";
  if (!nodeId) return { ok: false, message: "missing node_id" };
  let platform = String(device.platform || "unknown");
  if (platform === "unknown" && !opts.dryRun) {
    platform = await detectPlatform(client, nodeId, opts);
  }
  if (platform === "unknown") {
    return { ok: false, message: "cannot determine platform for remove" };
  }
  const result = await runOnDevice(client, nodeId, removeCommand(platform, pkg), {
    platform,
    dryRun: opts.dryRun,
    log: opts.log,
    timeoutMs: 600_000,
  });
  return { ok: result.ok, platform, package: pkg, output: result.output, dry_run: result.dry_run === true };
}
