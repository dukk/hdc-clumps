import { stderr as errout } from "node:process";

import { pctExec, sshRemote } from "hdc/package/pve-pct-remote.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const SAFE_TOKEN = /^[\w.@+-]+$/;
const SAFE_REPO = /^[\w.-]+\/[\w.-]+$/;
const SAFE_CIDR = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;
const SAFE_KEY = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * @param {string} name
 * @param {unknown} v
 * @param {RegExp} re
 */
function checked(name, v, re) {
  const s = typeof v === "string" ? v.trim() : String(v ?? "");
  if (!re.test(s)) throw new Error(`jevos ${name} has unsupported characters: ${JSON.stringify(s)}`);
  return s;
}

/**
 * systemd unit for `jev serve` (non-root, restart always, enabled at boot).
 * @param {{ host: string; port: number }} opts
 */
export function buildJevosUnit({ host, port }) {
  return [
    "[Unit]",
    "Description=jevos yes/no decision API (jev serve)",
    "Documentation=https://github.com/feder-cr/jev",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=jevos",
    "Group=jevos",
    "WorkingDirectory=/opt/jevos/current",
    "EnvironmentFile=/etc/jevos/jevos.env",
    "Environment=HOME=/var/lib/jevos",
    `ExecStart=/opt/jevos/current/jev serve --host ${host} --port ${port}`,
    "Restart=always",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * nftables ruleset: only allow the API port from the given CIDRs (best effort inside LXC).
 * @param {number} port
 * @param {string[]} cidrs
 */
export function buildJevosNftables(port, cidrs) {
  const set = cidrs.length ? cidrs.join(", ") : "10.0.0.0/8";
  return [
    "#!/usr/sbin/nft -f",
    "flush ruleset",
    "table inet jevos {",
    "  chain input {",
    "    type filter hook input priority 0; policy accept;",
    "    iif lo accept",
    `    tcp dport ${port} ip saddr { ${set} } accept`,
    `    tcp dport ${port} drop`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Install script for the CT (run via `pct exec … bash -s`, so the API key never hits argv).
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} server
 * @param {{ apiKey: string }} opts
 */
export function buildJevosInstallScript(install, server, opts) {
  const repo = checked("install.repo", install.repo ?? "feder-cr/jev", SAFE_REPO);
  const tag = checked("install.release", install.release ?? "jevos-v4", SAFE_TOKEN);
  const binAsset = checked("install.binary_asset", install.binary_asset ?? "jev-linux-x64.tar.gz", SAFE_TOKEN);
  const modelAsset = checked(
    "install.model_asset",
    install.model_asset ?? "jevos-v4-openvino-int8.zip",
    SAFE_TOKEN,
  );
  const host = checked("server.host", isObject(server) && server.host ? server.host : "0.0.0.0", SAFE_TOKEN);
  const portRaw = isObject(server) ? Number(server.port ?? 8017) : 8017;
  if (!Number.isInteger(portRaw) || portRaw <= 0 || portRaw > 65535) throw new Error("server.port invalid");
  const cidrs = (isObject(server) && Array.isArray(server.allow_cidrs) ? server.allow_cidrs : []).map((c) =>
    checked("server.allow_cidrs[]", c, SAFE_CIDR),
  );
  const apiKey = checked("api key", opts.apiKey, SAFE_KEY);
  const base = `https://github.com/${repo}/releases/download/${tag}`;

  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates tar unzip nftables >/dev/null",
    `TAG=${tag}`,
    `BASE=${base}`,
    "CACHE=/var/cache/jevos",
    'REL="/opt/jevos/releases/$TAG"',
    'mkdir -p "$CACHE" /opt/jevos/releases',
    'cd "$CACHE"',
    'curl -fsSL --retry 3 -o SHA256SUMS.txt "$BASE/SHA256SUMS.txt" || : > SHA256SUMS.txt',
    "want_sum() { awk -v f=\"$1\" '{n=$2; sub(/^\\*/,\"\",n)} n==f {print $1}' SHA256SUMS.txt; }",
    `for A in ${binAsset} ${modelAsset}; do`,
    '  WANT=$(want_sum "$A")',
    '  HAVE=$( [ -f "$A" ] && sha256sum "$A" | cut -d" " -f1 || true)',
    '  if [ -z "$HAVE" ] || { [ -n "$WANT" ] && [ "$HAVE" != "$WANT" ]; }; then',
    '    echo "jevos: downloading $A"',
    '    curl -fL --retry 3 -sS -o "$A.part" "$BASE/$A" && mv "$A.part" "$A"',
    '    HAVE=$(sha256sum "$A" | cut -d" " -f1)',
    "  fi",
    '  if [ -n "$WANT" ] && [ "$HAVE" != "$WANT" ]; then echo "jevos: sha256 mismatch for $A" >&2; exit 1; fi',
    '  [ -n "$WANT" ] && echo "jevos: sha256 ok $A" || echo "jevos: WARNING no SHA256SUMS entry for $A"',
    "done",
    'rm -rf "$REL.new" && mkdir -p "$REL.new"',
    `tar -xzf "$CACHE/${binAsset}" -C "$REL.new"`,
    'JEVDIR=$(dirname "$(find "$REL.new" -maxdepth 3 -type f -name jev | head -1)")',
    'test -x "$JEVDIR/jev"',
    `(cd "$JEVDIR" && unzip -q -o "$CACHE/${modelAsset}")`,
    'test -d "$JEVDIR/model"',
    'rm -rf "$REL" && mv "$REL.new" "$REL"',
    'JEVDIR=$(dirname "$(find "$REL" -maxdepth 3 -type f -name jev | head -1)")',
    'ln -sfn "$JEVDIR" /opt/jevos/current',
    'echo "$TAG" > /opt/jevos/version.txt',
    "id jevos >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -U -m -d /var/lib/jevos jevos",
    "chown -R root:root /opt/jevos && chmod -R a+rX,go-w /opt/jevos",
    "install -d -m 0750 -o root -g root /etc/jevos",
    "umask 077",
    "cat > /etc/jevos/jevos.env <<'ENV'",
    `JEV_API_KEY=${apiKey}`,
    "ENV",
    "chmod 0600 /etc/jevos/jevos.env",
    "umask 022",
    "cat > /etc/systemd/system/jevos.service <<'UNIT'",
    buildJevosUnit({ host, port: portRaw }),
    "UNIT",
    "cat > /etc/nftables.conf <<'NFT'",
    buildJevosNftables(portRaw, cidrs),
    "NFT",
    'if nft -f /etc/nftables.conf 2>/dev/null; then systemctl enable -q nftables || true; echo "jevos: nftables restricted :' +
      portRaw +
      '"; else echo "jevos: WARNING nftables not usable in this CT (port not restricted)"; fi',
    "systemctl daemon-reload",
    "systemctl enable -q jevos",
    "systemctl restart jevos",
    "for i in $(seq 1 90); do",
    `  if curl -fsS -m 3 http://127.0.0.1:${portRaw}/health >/dev/null 2>&1; then echo "jevos: healthy after \${i}x2s"; exit 0; fi`,
    "  sleep 2",
    "done",
    "echo 'jevos: service did not become healthy' >&2",
    "journalctl -u jevos -n 40 --no-pager >&2 || true",
    "exit 1",
  ].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export async function ensureCtRunning(user, pveHost, vmid) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const st = sshRemote(user, pveHost, `pct status ${vmid}`, { capture: true });
    if (/status:\s*running/.test(st.stdout)) {
      const r = pctExec(user, pveHost, vmid, "true", { capture: true });
      if (r.status === 0) return;
    } else if (/status:\s*stopped/.test(st.stdout)) {
      errout.write(`[hdc] jevos install: starting CT ${vmid} …\n`);
      sshRemote(user, pveHost, `pct start ${vmid}`, { capture: true });
    }
    errout.write(`[hdc] jevos install: waiting for CT ${vmid} (attempt ${attempt}) …\n`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`CT ${vmid} did not become ready`);
}

/**
 * Pin the CT to host CPUs `cpus` (raw `lxc.cgroup2.cpuset.cpus`). OpenVINO's CPU plugin segfaults
 * ("free(): invalid next size") when the CT's affinity mask (e.g. 7,13) does not match the CPU ids
 * lxcfs exposes in /proc/cpuinfo (0..n-1); a cpuset starting at 0 keeps them aligned.
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} cpus e.g. "0-1"
 * @returns {boolean} true when the config changed (CT needs a restart)
 */
export function ensureLxcCpuset(user, pveHost, vmid, cpus) {
  const c = checked("proxmox.lxc.cpuset", cpus, /^[0-9]+(?:[-,][0-9]+)*$/);
  const conf = `/etc/pve/lxc/${vmid}.conf`;
  const line = `lxc.cgroup2.cpuset.cpus: ${c}`;
  const cmd =
    `if grep -qxF '${line}' ${conf}; then echo unchanged; else ` +
    `sed -i '/^lxc.cgroup2.cpuset.cpus:/d' ${conf} && echo '${line}' >> ${conf} && echo changed; fi`;
  const r = sshRemote(user, pveHost, cmd, { capture: true });
  if (r.status !== 0) throw new Error(`cpuset update failed on ${vmid}: ${r.stderr.trim()}`);
  return /changed/.test(r.stdout);
}

/**
 * Wait for outbound network inside the CT (static IP, DNS).
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
async function waitForCtNetwork(user, pveHost, vmid) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const r = pctExec(user, pveHost, vmid, "getent hosts github.com >/dev/null", { capture: true });
    if (r.status === 0) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`CT ${vmid}: no DNS/network (github.com unresolvable)`);
}

/**
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.pveHost
 * @param {number} opts.vmid
 * @param {Record<string, unknown>} opts.install
 * @param {Record<string, unknown>} opts.server
 * @param {string} opts.apiKey
 */
export async function installJevosInCt(opts) {
  const { user, pveHost, vmid, install, server, apiKey, cpuset } = opts;
  errout.write(`[hdc] jevos install: release ${String(install.release)} in CT ${vmid} …\n`);
  if (cpuset && ensureLxcCpuset(user, pveHost, vmid, cpuset)) {
    errout.write(`[hdc] jevos install: pinned CT ${vmid} to cpuset ${cpuset}; restarting CT …\n`);
    sshRemote(user, pveHost, `pct reboot ${vmid} || (pct stop ${vmid}; pct start ${vmid})`, { capture: true });
  }
  await ensureCtRunning(user, pveHost, vmid);
  await waitForCtNetwork(user, pveHost, vmid);
  const script = buildJevosInstallScript(install, server, { apiKey });
  const r = pctExec(user, pveHost, vmid, script, { stdin: true });
  if (r.status !== 0) {
    return { ok: false, message: `install failed (exit ${r.status})` };
  }
  errout.write(`[hdc] jevos install: completed on CT ${vmid}.\n`);
  return { ok: true, release: install.release, message: "installed" };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function queryJevosInCt(user, pveHost, vmid) {
  const r = pctExec(
    user,
    pveHost,
    vmid,
    "printf 'active=%s enabled=%s version=%s\\n' \"$(systemctl is-active jevos 2>/dev/null)\" \"$(systemctl is-enabled jevos 2>/dev/null)\" \"$(cat /opt/jevos/version.txt 2>/dev/null)\"",
    { capture: true },
  );
  const m = /active=(\S*) enabled=(\S*) version=(\S*)/.exec(r.stdout);
  return {
    service_active: m ? m[1] : null,
    service_enabled: m ? m[2] : null,
    release: m && m[3] ? m[3] : null,
  };
}
