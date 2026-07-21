import { stderr as errout } from "node:process";

import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { waitForCt } from "../../ollama/lib/ollama-install.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { crowdsecLapiPort } from "./deployments.mjs";
import { installCrowdsecCollectionsInCt } from "./crowdsec-collections.mjs";
import { installUnifiSyslogInCt } from "./crowdsec-unifi-syslog.mjs";

export { resolvePveSshForHost };

/** Default LAN CIDRs allowed to auto-register agents to LAPI. */
export const DEFAULT_AUTO_REGISTRATION_RANGES = [
  "192.0.2.0/24",
  "10.1.0.0/16",
  "10.2.0.0/16",
  "192.168.0.0/16",
];

/**
 * @param {unknown} crowdsec
 * @returns {string[]}
 */
export function crowdsecAutoRegistrationRanges(crowdsec) {
  if (!crowdsec || typeof crowdsec !== "object" || Array.isArray(crowdsec)) {
    return [...DEFAULT_AUTO_REGISTRATION_RANGES];
  }
  const raw = /** @type {Record<string, unknown>} */ (crowdsec).auto_registration_allowed_ranges;
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_AUTO_REGISTRATION_RANGES];
  const ranges = raw
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => /** @type {string} */ (v).trim());
  return ranges.length ? ranges : [...DEFAULT_AUTO_REGISTRATION_RANGES];
}

/**
 * @param {number} lapiPort
 * @param {{ upgrade?: boolean; enrollToken?: string; allowedRanges?: string[] }} [opts]
 */
export function buildInstallScript(lapiPort, opts = {}) {
  const port = Number.isFinite(lapiPort) ? lapiPort : 8080;
  const upgrade = opts.upgrade === true;
  const enrollToken = typeof opts.enrollToken === "string" ? opts.enrollToken.trim() : "";
  const allowedRanges = Array.isArray(opts.allowedRanges) && opts.allowedRanges.length
    ? opts.allowedRanges
    : DEFAULT_AUTO_REGISTRATION_RANGES;
  const lines = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    // Fresh Ubuntu CTs often break apt update via command-not-found sqlite I/O errors.
    "rm -f /etc/apt/apt.conf.d/50command-not-found 2>/dev/null || true",
    "chmod a-x /usr/lib/cnf-update-db 2>/dev/null || true",
    // Prior OOM/no-space installs leave corrupt lists; always refresh cleanly.
    "rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial 2>/dev/null || true",
    "apt-get clean || true",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates python3-yaml",
    "if ! command -v crowdsec >/dev/null 2>&1; then",
    "  curl -s https://packagecloud.io/install/repositories/crowdsec/crowdsec/script.deb.sh | bash",
    "  apt-get update -qq",
    "  apt-get install -y -qq crowdsec crowdsec-firewall-bouncer-iptables",
    "fi",
  ];
  if (upgrade) {
    lines.push(
      "apt-get install -y -qq --only-upgrade crowdsec crowdsec-firewall-bouncer-iptables || true",
    );
  }
  lines.push(
    "mkdir -p /etc/crowdsec",
    "apt-get install -y -qq python3-yaml",
  );
  // Python-only patch: cscli config set corrupts YAML when listen_uri contains colons.
  lines.push(
    `export ENROLL_TOKEN=${JSON.stringify(enrollToken)}`,
    `export ALLOWED_RANGES_JSON=${JSON.stringify(JSON.stringify(allowedRanges))}`,
    "python3 - <<'PY'",
    "import json, os, shutil, sys",
    "try:",
    "  import yaml",
    "except ImportError:",
    "  print('python3-yaml missing', file=sys.stderr)",
    "  sys.exit(1)",
    "path = '/etc/crowdsec/config.yaml'",
    "defaults = [",
    "  '/usr/share/crowdsec/config/config.yaml',",
    "  '/usr/share/doc/crowdsec/examples/config.yaml',",
    "]",
    "cfg = None",
    "with open(path, encoding='utf-8') as f:",
    "  try:",
    "    cfg = yaml.safe_load(f)",
    "  except Exception:",
    "    cfg = None",
    "if not isinstance(cfg, dict):",
    "  restored = False",
    "  for d in defaults:",
    "    if os.path.isfile(d):",
    "      shutil.copyfile(d, path)",
    "      restored = True",
    "      break",
    "  if not restored:",
    "    print('crowdsec config.yaml unreadable and no package default found', file=sys.stderr)",
    "    sys.exit(1)",
    "  with open(path, encoding='utf-8') as f:",
    "    cfg = yaml.safe_load(f) or {}",
    "api = cfg.setdefault('api', {})",
    "server = api.setdefault('server', {})",
    "server['enable'] = True",
    "server['listen_uri'] = f\"0.0.0.0:{os.environ.get('LAPI_PORT', '8080')}\"",
    "token = (os.environ.get('ENROLL_TOKEN') or '').strip()",
    "if token:",
    "  server['auto_registration'] = {",
    "    'enabled': True,",
    "    'token': token,",
    "    'allowed_ranges': json.loads(os.environ['ALLOWED_RANGES_JSON']),",
    "  }",
    "with open(path, 'w', encoding='utf-8') as f:",
    "  yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)",
    "print('crowdsec config.yaml patched (listen_uri + auto_registration)')",
    "PY",
  );
  lines.push(
    "systemctl enable crowdsec 2>/dev/null || true",
    "systemctl restart crowdsec",
    "sleep 2",
    "systemctl is-active --quiet crowdsec",
    "if command -v cscli >/dev/null 2>&1; then cscli lapi status >/dev/null 2>&1 || true; fi",
  );
  return [`export LAPI_PORT=${port}`, ...lines].join("\n");
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} crowdsec
 * @param {{ upgrade?: boolean; enrollToken?: string; skipCollections?: boolean; skipHubUpdate?: boolean }} [opts]
 */
export async function installCrowdsecInCt(user, pveHost, vmid, crowdsec, opts = {}) {
  const label = opts.upgrade ? "upgrade" : "install";
  errout.write(`[hdc] crowdsec ${label}: configuring CT ${vmid} ...\n`);
  const ready = await waitForCt(user, pveHost, vmid, 2000, `crowdsec ${label}`);
  if (!ready) {
    return { ok: false, method: label, message: `CT ${vmid} not reachable via pct exec` };
  }
  const enrollToken = typeof opts.enrollToken === "string" ? opts.enrollToken.trim() : "";
  const inner = buildInstallScript(crowdsecLapiPort(crowdsec), {
    upgrade: opts.upgrade === true,
    enrollToken,
    allowedRanges: crowdsecAutoRegistrationRanges(crowdsec),
  });
  const r = pctExec(user, pveHost, vmid, inner);
  if (r.status !== 0) {
    return {
      ok: false,
      method: label,
      message: `${label} failed (exit ${r.status})`,
      stderr: r.stderr?.slice(0, 800),
    };
  }

  const collections = installCrowdsecCollectionsInCt(user, pveHost, vmid, pctExec, crowdsec, {
    skip: opts.skipCollections === true,
    hubUpdate: opts.skipHubUpdate !== true,
  });
  const unifiSyslog = installUnifiSyslogInCt(user, pveHost, vmid, pctExec, crowdsec);

  const ok = collections.ok !== false && unifiSyslog.ok !== false;
  errout.write(`[hdc] crowdsec ${label}: completed on CT ${vmid}.\n`);
  return {
    ok,
    method: label,
    message: label === "upgrade" ? "upgraded" : "installed",
    collections,
    unifi_syslog: unifiSyslog,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} crowdsec
 * @param {{ enrollToken?: string; skipUpgrade?: boolean; skipCollections?: boolean; skipHubUpdate?: boolean }} [opts]
 */
export function maintainCrowdsecInCt(user, pveHost, vmid, crowdsec, opts = {}) {
  return installCrowdsecInCt(user, pveHost, vmid, crowdsec, {
    upgrade: opts.skipUpgrade !== true,
    enrollToken: opts.enrollToken,
    skipCollections: opts.skipCollections === true,
    skipHubUpdate: opts.skipHubUpdate === true,
  });
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function crowdsecInstalled(user, pveHost, vmid) {
  const r = pctExec(
    user,
    pveHost,
    vmid,
    "command -v crowdsec >/dev/null 2>&1 && systemctl list-unit-files crowdsec.service >/dev/null 2>&1 && echo yes",
    { capture: true },
  );
  return r.status === 0 && r.stdout.trim() === "yes";
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function readCtPrimaryIp(user, pveHost, vmid) {
  const r = pctExec(user, pveHost, vmid, "hostname -I | awk '{print $1}'", { capture: true });
  if (r.status !== 0) return null;
  const ip = r.stdout.trim().split(/\s+/)[0];
  return ip || null;
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function queryCrowdsecStatusInCt(user, pveHost, vmid) {
  const svc = pctExec(user, pveHost, vmid, "systemctl is-active crowdsec 2>/dev/null || echo inactive", {
    capture: true,
  });
  const lapi = pctExec(user, pveHost, vmid, "cscli lapi status 2>/dev/null || true", { capture: true });
  return {
    service: svc.stdout.trim() || "unknown",
    lapi_status: lapi.stdout.trim() || null,
  };
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {string} keyName
 */
export function createBouncerKeyInCt(user, pveHost, vmid, keyName) {
  const safe = keyName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const cmd = [
    "set -euo pipefail",
    `NAME=${JSON.stringify(safe)}`,
    'cscli bouncers delete "$NAME" >/dev/null 2>&1 || true',
    'cscli bouncers add "$NAME" -o raw',
  ].join("\n");
  const r = pctExec(user, pveHost, vmid, cmd, { capture: true });
  if (r.status !== 0) {
    return { ok: false, message: `cscli bouncers add failed (exit ${r.status})` };
  }
  const apiKey = r.stdout.trim();
  if (!apiKey) return { ok: false, message: "empty bouncer api key from cscli" };
  return { ok: true, apiKey };
}
