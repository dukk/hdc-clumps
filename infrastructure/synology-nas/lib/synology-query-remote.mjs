import { buildDockerProbeScript, parseDockerSectionOutput } from "./synology-docker-ensure.mjs";
import { synologyRemoteExec } from "./synology-ssh.mjs";

const HEALTH_SCRIPT = `
set -euo pipefail
echo '===DSM_VERSION==='
(grep -E '^productversion=' /etc.defaults/synoinfo.conf 2>/dev/null || grep -E '^productversion=' /etc/synoinfo.conf 2>/dev/null || synogetkeyvalue /etc.defaults/synoinfo.conf productversion 2>/dev/null || echo 'unknown') | head -1
echo '===UPTIME==='
uptime 2>/dev/null || true
echo '===DF==='
df -hP 2>/dev/null | awk 'NR==1 || $6 ~ /^\\/volume/' || true
echo '===MDSTAT==='
cat /proc/mdstat 2>/dev/null || true
echo '===DISKS==='
if [ -x /usr/syno/bin/synodisk ]; then
  /usr/syno/bin/synodisk -enum 2>/dev/null || true
elif [ -d /dev/disk/by-id ]; then
  ls -la /dev/disk/by-id 2>/dev/null | head -40 || true
fi
${buildDockerProbeScript()}
`.trim();

/**
 * @param {string} line
 */
export function parseDsmVersionLine(line) {
  const t = line.trim();
  const m = t.match(/productversion\s*=\s*"?([^"\s]+)"?/i);
  if (m) return m[1].trim();
  if (t && !t.startsWith("===")) return t;
  return null;
}

/**
 * @param {string} dfText
 * @returns {{ mount: string; size: string; used: string; avail: string; usePct: string }[]}
 */
export function parseDfVolumes(dfText) {
  /** @type {{ mount: string; size: string; used: string; avail: string; usePct: string }[]} */
  const rows = [];
  for (const line of dfText.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6 || parts[0] === "Filesystem") continue;
    const mount = parts[5];
    if (!mount.startsWith("/volume")) continue;
    rows.push({
      mount,
      size: parts[1],
      used: parts[2],
      avail: parts[3],
      usePct: parts[4],
    });
  }
  return rows;
}

/**
 * @param {string} mdText
 * @returns {{ arrays: { name: string; state: string; level: string; devices: string }[]; degraded: boolean }}
 */
export function parseMdstat(mdText) {
  /** @type {{ name: string; state: string; level: string; devices: string }[]} */
  const arrays = [];
  let degraded = false;
  const blocks = mdText.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length || !lines[0].includes("md")) continue;
    const head = lines[0].trim();
    const nameMatch = head.match(/^(md\d+)/);
    if (!nameMatch) continue;
    const stateLine =
      lines.find((l) => /\[\d+\/\d+\]\s*\[[^\]]+\]/.test(l)) ??
      lines.find((l) => /blocks super/.test(l)) ??
      "";
    const stateMatch = stateLine.match(/\[(\d+)\/(\d+)\]\s*\[([^\]]+)\]/);
    const levelMatch = head.match(/\b(raid\d+|linear)\b/i);
    const devices = lines
      .filter((l) => /\b(sd[a-z]|nvme\d+n\d+)\d*\b/i.test(l))
      .join(" ")
      .trim();
    const state = stateMatch ? stateMatch[3] : "unknown";
    if (stateMatch && Number(stateMatch[1]) > Number(stateMatch[2])) degraded = true;
    if (/degraded|recovering|resync|rebuild|missing/i.test(stateLine + head)) degraded = true;
    if (/\[.*_.*\]/.test(stateLine)) degraded = true;
    arrays.push({
      name: nameMatch[1],
      state,
      level: levelMatch ? levelMatch[1] : "—",
      devices: devices || "—",
    });
  }
  if (/degraded/i.test(mdText)) degraded = true;
  return { arrays, degraded };
}

/**
 * @param {string} diskText
 * @returns {{ lines: string[] }}
 */
export function parseDiskEnum(diskText) {
  const lines = diskText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("==="));
  return { lines: lines.slice(0, 40) };
}

/**
 * @param {string} raw
 */
export function parseHealthCollectOutput(raw) {
  const sections = {
    dsm: "",
    uptime: "",
    df: "",
    mdstat: "",
    disks: "",
  };
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line === "===DSM_VERSION===") {
      current = "dsm";
      continue;
    }
    if (line === "===UPTIME===") {
      current = "uptime";
      continue;
    }
    if (line === "===DF===") {
      current = "df";
      continue;
    }
    if (line === "===MDSTAT===") {
      current = "mdstat";
      continue;
    }
    if (line === "===DISKS===") {
      current = "disks";
      continue;
    }
    if (line.startsWith("===DOCKER_") || line.startsWith("===COMPOSE_") || line.startsWith("===ACTION===") || line.startsWith("===RESULT===")) {
      current = "";
      continue;
    }
    if (current) sections[/** @type {keyof sections} */ (current)] += `${line}\n`;
  }

  const dsmLine = sections.dsm.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const dockerParsed = parseDockerSectionOutput(raw);
  return {
    dsmVersion: parseDsmVersionLine(dsmLine),
    uptime: sections.uptime.trim() || null,
    volumes: parseDfVolumes(sections.df),
    raid: parseMdstat(sections.mdstat),
    disks: parseDiskEnum(sections.disks),
    docker: {
      package: dockerParsed.package,
      status: dockerParsed.status,
      running: dockerParsed.running,
      docker_cli: dockerParsed.dockerCli,
      version: dockerParsed.dockerVersion,
      compose: dockerParsed.composeAvailable,
      compose_version: dockerParsed.composeVersion,
      containers: Array.isArray(dockerParsed.containers) ? dockerParsed.containers : [],
    },
    rawExcerpt: raw.slice(0, 4000),
  };
}

/**
 * @param {object} opts
 * @param {{ id: string; user: string; host: string }} opts.target
 * @param {{ mode: "pubkey" | "password"; password: string | null }} opts.auth
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ privateKey: string; certificateFile?: string }[]} opts.identities
 */
export function collectSynologyHealth(opts) {
  const r = synologyRemoteExec(opts, HEALTH_SCRIPT);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `${r.stderr || r.stdout}`.trim() || `remote exit ${r.status}`,
      health: null,
    };
  }
  const health = parseHealthCollectOutput(r.stdout);
  return { ok: true, message: null, health };
}

/**
 * @param {string} text
 */
export function parseSynoupgradeCheck(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const available = lines.find((l) => /available update/i.test(l)) ?? null;
  const noUpdate = lines.some((l) => /no.*update|already.*latest|up to date/i.test(l));
  return {
    updateAvailable: Boolean(available) && !noUpdate,
    summary: available ?? (lines.slice(-3).join(" ") || "check completed"),
    raw: text.slice(0, 2000),
  };
}
