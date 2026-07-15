/**
 * Ensure no-subscription APT sources, disable enterprise repos, remove subscription UI nag.
 * Logic ported from community-scripts/ProxmoxVE post-pve-install.sh (MIT) — non-interactive only.
 */
import { existsSync, readFileSync } from "node:fs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { join } from "node:path";

import { loadProxmoxPackageConfig } from "./proxmox-package-config.mjs";
import { isProxmoxConfigObject } from "./proxmox-config.mjs";
import { listProxmoxHypervisorSshTargets } from "./proxmox-host-os-maintain.mjs";
import { parsePveVersionFromCli, pveVersionFromConfigCluster } from "./pve-version.mjs";
import {
  discoverLocalSshMaterial,
  shellSingleQuote,
  sshBashLc,
  sshReachableWithPubkey,
} from "hdc/cli/lib/ssh-host-access.mjs";

/** @typedef {object} AptSourcesOptions
 * @property {boolean} disableEnterprise
 * @property {boolean} enableNoSubscription
 * @property {boolean} disableCephEnterprise
 * @property {boolean} removeSubscriptionNag
 */

/** @typedef {object} AptSourcesAudit
 * @property {number | null} major
 * @property {string} format
 * @property {boolean} enterpriseActive
 * @property {boolean} noSubActive
 * @property {boolean} nagScript
 * @property {boolean} nagAptConf
 * @property {boolean} debianSourcesOk
 * @property {boolean} needsApply
 */

/** @typedef {object} AptSourcesHostResult
 * @property {string} hostId
 * @property {number | null} major
 * @property {boolean} changed
 * @property {boolean} ok
 * @property {string} [error]
 * @property {string} [summary]
 */

/**
 * Subscription nag remover (from community-scripts post-pve-install.sh, MIT).
 * Re-applied via DPkg::Post-Invoke after proxmox-widget-toolkit upgrades.
 */
export const PVE_REMOVE_NAG_SCRIPT = `#!/bin/sh
WEB_JS=/usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
if [ -s "$WEB_JS" ] && ! grep -q NoMoreNagging "$WEB_JS"; then
    echo "Patching Web UI nag..."
    sed -i -e "/data\\.status/ s/!//" -e "/data\\.status/ s/active/NoMoreNagging/" "$WEB_JS"
fi

MOBILE_TPL=/usr/share/pve-yew-mobile-gui/index.html.tpl
MARKER="<!-- MANAGED BLOCK FOR MOBILE NAG -->"
if [ -f "$MOBILE_TPL" ] && ! grep -q "$MARKER" "$MOBILE_TPL"; then
    echo "Patching Mobile UI nag..."
    printf "%s\\n" \\
      "$MARKER" \\
      "<script>" \\
      "  function removeSubscriptionElements() {" \\
      "    const dialogs = document.querySelectorAll('dialog.pwt-outer-dialog');" \\
      "    dialogs.forEach(dialog => {" \\
      "      const text = (dialog.textContent || '').toLowerCase();" \\
      "      if (text.includes('subscription')) {" \\
      "        dialog.remove();" \\
      "      }" \\
      "    });" \\
      "    const cards = document.querySelectorAll('.pwt-card.pwt-p-2.pwt-d-flex.pwt-interactive.pwt-justify-content-center');" \\
      "    cards.forEach(card => {" \\
      "      const text = (card.textContent || '').toLowerCase();" \\
      "      const hasButton = card.querySelector('button');" \\
      "      if (!hasButton && text.includes('subscription')) {" \\
      "        card.remove();" \\
      "      }" \\
      "    });" \\
      "  }" \\
      "  const observer = new MutationObserver(removeSubscriptionElements);" \\
      "  observer.observe(document.body, { childList: true, subtree: true });" \\
      "  removeSubscriptionElements();" \\
      "  setInterval(removeSubscriptionElements, 300);" \\
      "  setTimeout(() => {observer.disconnect();}, 10000);" \\
      "</script>" \\
      "" >> "$MOBILE_TPL"
fi
`;

const PVE_NO_NAG_APT_CONF = 'DPkg::Post-Invoke { "/usr/local/bin/pve-remove-nag.sh"; };\n';

/**
 * @param {unknown} cfg
 */
export function aptSourcesMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return true;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return true;
  const aptSources = provision.apt_sources;
  if (!isProxmoxConfigObject(aptSources)) return true;
  return aptSources.enabled !== false && aptSources.enabled !== 0;
}

/**
 * @param {unknown} cfg
 * @returns {AptSourcesOptions}
 */
export function aptSourcesOptionsFromConfig(cfg) {
  /** @type {AptSourcesOptions} */
  const defaults = {
    disableEnterprise: true,
    enableNoSubscription: true,
    disableCephEnterprise: true,
    removeSubscriptionNag: true,
  };
  if (!isProxmoxConfigObject(cfg)) return defaults;
  const provision = cfg.provision;
  if (!isProxmoxConfigObject(provision)) return defaults;
  const aptSources = provision.apt_sources;
  if (!isProxmoxConfigObject(aptSources)) return defaults;
  return {
    disableEnterprise: aptSources.disable_enterprise !== false && aptSources.disable_enterprise !== 0,
    enableNoSubscription:
      aptSources.enable_no_subscription !== false && aptSources.enable_no_subscription !== 0,
    disableCephEnterprise:
      aptSources.disable_ceph_enterprise !== false && aptSources.disable_ceph_enterprise !== 0,
    removeSubscriptionNag:
      aptSources.remove_subscription_nag !== false && aptSources.remove_subscription_nag !== 0,
  };
}

/**
 * @param {8 | 9 | number} major
 * @returns {string | null}
 */
export function debianSuiteForPveMajor(major) {
  if (major === 8) return "bookworm";
  if (major === 9) return "trixie";
  return null;
}

/**
 * Remote audit: prints key=value lines on stdout.
 * @returns {string}
 */
export function buildAptSourcesAuditScript() {
  return `
set -euo pipefail
shopt -s nullglob

major=""
if command -v pveversion >/dev/null 2>&1; then
  major=$(pveversion 2>/dev/null | awk -F'/' '{print $2}' | awk -F'-' '{print $1}' | awk -F'.' '{print $1}')
fi
if [ -z "$major" ] && command -v pve >/dev/null 2>&1; then
  major=$(pve version 2>/dev/null | sed -n 's/.*pve-manager\\/\\([0-9]*\\).*/\\1/p' | head -1)
fi
echo "major=$major"

format=legacy
if find /etc/apt/sources.list.d -maxdepth 1 -name '*.sources' 2>/dev/null | grep -q .; then
  format=deb822
fi
echo "format=$format"

enterprise_active=0
no_sub_active=0

if [ "$format" = "deb822" ]; then
  for f in /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    if grep -qE 'Components:.*pve-enterprise' "$f" 2>/dev/null; then
      if ! grep -qE '^Enabled:[[:space:]]*false' "$f" 2>/dev/null; then
        enterprise_active=1
      fi
    fi
    if grep -qE 'Components:.*pve-no-subscription' "$f" 2>/dev/null; then
      if ! grep -qE '^Enabled:[[:space:]]*false' "$f" 2>/dev/null; then
        no_sub_active=1
      fi
    fi
  done
else
  if grep -h -rE '^[[:space:]]*deb[[:space:]].*pve-enterprise' /etc/apt/sources.list.d/*.list 2>/dev/null | grep -q .; then
    enterprise_active=1
  fi
  if grep -h -rE '^[[:space:]]*deb[[:space:]].*pve-no-subscription' /etc/apt/sources.list.d/*.list 2>/dev/null | grep -q .; then
    no_sub_active=1
  fi
fi
echo "enterprise_active=$enterprise_active"
echo "no_sub_active=$no_sub_active"

nag_script=0
nag_apt_conf=0
[ -x /usr/local/bin/pve-remove-nag.sh ] && nag_script=1
[ -f /etc/apt/apt.conf.d/no-nag-script ] && nag_apt_conf=1
echo "nag_script=$nag_script"
echo "nag_apt_conf=$nag_apt_conf"

debian_sources_ok=0
if [ -f /etc/apt/sources.list ] && grep -qE '^[[:space:]]*deb[[:space:]].*deb\\.debian\\.org' /etc/apt/sources.list 2>/dev/null; then
  debian_sources_ok=1
fi
if [ "$format" = "deb822" ] && [ -f /etc/apt/sources.list.d/debian.sources ]; then
  if grep -q 'URIs: http://deb.debian.org/debian' /etc/apt/sources.list.d/debian.sources 2>/dev/null; then
    debian_sources_ok=1
  fi
fi
echo "debian_sources_ok=$debian_sources_ok"
`.trim();
}

/**
 * @param {string} stdout
 * @param {AptSourcesOptions} options
 * @returns {AptSourcesAudit}
 */
export function parseAptSourcesAudit(stdout, options) {
  /** @type {Record<string, string>} */
  const kv = {};
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    kv[t.slice(0, eq)] = t.slice(eq + 1);
  }

  const majorRaw = Number(kv.major);
  const major = majorRaw === 8 || majorRaw === 9 ? majorRaw : null;
  const format = kv.format === "deb822" ? "deb822" : "legacy";
  const enterpriseActive = kv.enterprise_active === "1";
  const noSubActive = kv.no_sub_active === "1";
  const nagScript = kv.nag_script === "1";
  const nagAptConf = kv.nag_apt_conf === "1";
  const debianSourcesOk = kv.debian_sources_ok === "1";

  let needsApply = false;
  if (options.disableEnterprise && enterpriseActive) needsApply = true;
  if (options.enableNoSubscription && !noSubActive) needsApply = true;
  if (options.removeSubscriptionNag && (!nagScript || !nagAptConf)) needsApply = true;
  if (!debianSourcesOk) needsApply = true;

  return {
    major,
    format,
    enterpriseActive,
    noSubActive,
    nagScript,
    nagAptConf,
    debianSourcesOk,
    needsApply,
  };
}

/**
 * @param {object} params
 * @param {8 | 9} params.major
 * @param {string} params.suite
 * @param {AptSourcesOptions} params.options
 * @returns {string}
 */
export function buildAptSourcesApplyScript({ major, suite, options }) {
  const disableEnt = options.disableEnterprise ? "1" : "0";
  const enableNoSub = options.enableNoSubscription ? "1" : "0";
  const disableCeph = options.disableCephEnterprise ? "1" : "0";
  const removeNag = options.removeSubscriptionNag ? "1" : "0";

  const nagScriptB64 = Buffer.from(PVE_REMOVE_NAG_SCRIPT, "utf8").toString("base64");
  const nagConfB64 = Buffer.from(PVE_NO_NAG_APT_CONF, "utf8").toString("base64");

  const pve8SourcesList = `deb http://deb.debian.org/debian ${suite} main contrib
deb http://deb.debian.org/debian ${suite}-updates main contrib
deb http://security.debian.org/debian-security ${suite}-security main contrib
`;

  const pve8EnterpriseList = `# deb https://enterprise.proxmox.com/debian/pve ${suite} pve-enterprise
`;

  const pve8NoSubList = `deb http://download.proxmox.com/debian/pve ${suite} pve-no-subscription
`;

  const pve8CephList = `# deb https://enterprise.proxmox.com/debian/ceph-quincy ${suite} enterprise
# deb http://download.proxmox.com/debian/ceph-quincy ${suite} no-subscription
# deb https://enterprise.proxmox.com/debian/ceph-reef ${suite} enterprise
# deb http://download.proxmox.com/debian/ceph-reef ${suite} no-subscription
`;

  const debianSourcesPve9 = `Types: deb
URIs: http://deb.debian.org/debian
Suites: ${suite}
Components: main contrib
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://security.debian.org/debian-security
Suites: ${suite}-security
Components: main contrib
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://deb.debian.org/debian
Suites: ${suite}-updates
Components: main contrib
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
`;

  const proxmoxSourcesPve9 = `Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: ${suite}
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
`;

  return `
set -euo pipefail
shopt -s nullglob
CHANGED=0
HDC_DISABLE_ENT=${disableEnt}
HDC_ENABLE_NO_SUB=${enableNoSub}
HDC_DISABLE_CEPH=${disableCeph}
HDC_REMOVE_NAG=${removeNag}
HDC_MAJOR=${major}
HDC_SUITE=${shellSingleQuote(suite)}

write_if_changed() {
  local path="$1"
  local want="$2"
  local cur=""
  if [ -f "$path" ]; then cur=$(cat "$path" 2>/dev/null || true); fi
  if [ "$cur" = "$want" ]; then return 0; fi
  install -d "$(dirname "$path")"
  printf '%s' "$want" >"$path"
  CHANGED=1
}

if [ "$HDC_MAJOR" = "8" ]; then
  write_if_changed /etc/apt/sources.list ${shellSingleQuote(pve8SourcesList)}
  write_if_changed /etc/apt/apt.conf.d/no-bookworm-firmware.conf 'APT::Get::Update::SourceListWarnings::NonFreeFirmware "false";\n'
  if [ "$HDC_DISABLE_ENT" = "1" ]; then
    write_if_changed /etc/apt/sources.list.d/pve-enterprise.list ${shellSingleQuote(pve8EnterpriseList)}
  fi
  if [ "$HDC_ENABLE_NO_SUB" = "1" ]; then
    write_if_changed /etc/apt/sources.list.d/pve-install-repo.list ${shellSingleQuote(pve8NoSubList)}
  fi
  if [ "$HDC_DISABLE_CEPH" = "1" ]; then
    write_if_changed /etc/apt/sources.list.d/ceph.list ${shellSingleQuote(pve8CephList)}
  fi
fi

if [ "$HDC_MAJOR" = "9" ]; then
  has_deb822=0
  if find /etc/apt/sources.list.d -maxdepth 1 -name '*.sources' 2>/dev/null | grep -q .; then
    has_deb822=1
  fi
  if [ "$has_deb822" = "0" ]; then
    write_if_changed /etc/apt/sources.list.d/debian.sources ${shellSingleQuote(debianSourcesPve9)}
    rm -f /etc/apt/sources.list.d/*.list 2>/dev/null || true
    if [ -f /etc/apt/sources.list ]; then
      sed -i '/proxmox/d;/bookworm/d;/trixie/d' /etc/apt/sources.list 2>/dev/null || true
    fi
  fi
  if [ "$HDC_DISABLE_ENT" = "1" ]; then
    for f in /etc/apt/sources.list.d/*.sources; do
      [ -f "$f" ] || continue
      if grep -qE 'Components:.*pve-enterprise' "$f" 2>/dev/null; then
        if grep -qE '^Enabled:' "$f" 2>/dev/null; then
          sed -i 's/^Enabled:.*/Enabled: false/' "$f"
        else
          echo "Enabled: false" >>"$f"
        fi
        CHANGED=1
      fi
    done
  fi
  if [ "$HDC_ENABLE_NO_SUB" = "1" ]; then
    has_no_sub=0
    for f in /etc/apt/sources.list.d/*.sources; do
      [ -f "$f" ] || continue
      if grep -qE 'Components:.*pve-no-subscription' "$f" 2>/dev/null; then
        has_no_sub=1
        if grep -qE '^Enabled:[[:space:]]*false' "$f" 2>/dev/null; then
          sed -i '/^Enabled:/d' "$f"
          CHANGED=1
        fi
      fi
    done
    if [ "$has_no_sub" = "0" ]; then
      write_if_changed /etc/apt/sources.list.d/proxmox.sources ${shellSingleQuote(proxmoxSourcesPve9)}
    fi
  fi
  if [ "$HDC_DISABLE_CEPH" = "1" ]; then
    for f in /etc/apt/sources.list.d/*.sources; do
      [ -f "$f" ] || continue
      if grep -q 'enterprise.proxmox.com.*ceph' "$f" 2>/dev/null; then
        if grep -qE '^Enabled:' "$f" 2>/dev/null; then
          sed -i 's/^Enabled:.*/Enabled: false/' "$f"
        else
          echo "Enabled: false" >>"$f"
        fi
        CHANGED=1
      fi
    done
    for f in /etc/apt/sources.list.d/*.list; do
      [ -f "$f" ] || continue
      if grep -q 'enterprise.proxmox.com.*ceph' "$f" 2>/dev/null; then
        sed -i '/enterprise.proxmox.com.*ceph/s/^/# /' "$f"
        CHANGED=1
      fi
    done
  fi
fi

if [ "$HDC_REMOVE_NAG" = "1" ]; then
  mkdir -p /usr/local/bin
  NAG_WANT=$(printf '%s' '${nagScriptB64}' | base64 -d)
  NAG_CUR=""
  if [ -f /usr/local/bin/pve-remove-nag.sh ]; then NAG_CUR=$(cat /usr/local/bin/pve-remove-nag.sh 2>/dev/null || true); fi
  if [ "$NAG_CUR" != "$NAG_WANT" ]; then
    printf '%s' "$NAG_WANT" > /usr/local/bin/pve-remove-nag.sh
    chmod 755 /usr/local/bin/pve-remove-nag.sh
    CHANGED=1
  fi
  CONF_WANT=$(printf '%s' '${nagConfB64}' | base64 -d)
  write_if_changed /etc/apt/apt.conf.d/no-nag-script "$CONF_WANT"
  if [ "$CHANGED" = "1" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install --reinstall -y -qq proxmox-widget-toolkit >/dev/null 2>&1 || true
    /usr/local/bin/pve-remove-nag.sh || true
  fi
fi

if [ "$CHANGED" = "1" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
fi

echo "changed=$CHANGED"
`.trim();
}

/**
 * @param {unknown} cfg
 * @param {string | null} clusterId
 * @returns {8 | 9 | null}
 */
export function pveMajorFromConfigCluster(cfg, clusterId) {
  if (!isProxmoxConfigObject(cfg) || !clusterId) return null;
  const clusters = Array.isArray(cfg.clusters) ? cfg.clusters : [];
  for (const cl of clusters) {
    if (!isProxmoxConfigObject(cl)) continue;
    if (typeof cl.id !== "string" || cl.id.trim() !== clusterId) continue;
    const v = pveVersionFromConfigCluster(cl);
    if (v && (v.major === 8 || v.major === 9)) return v.major;
  }
  return null;
}

/**
 * @param {AptSourcesHostResult} r
 * @param {AptSourcesAudit} [audit]
 */
export function formatAptSourcesHostSummary(r, audit) {
  if (r.error) return `${r.hostId}: fail (${r.error})`;
  const parts = [];
  if (r.major) parts.push(`pve${r.major}`);
  if (r.changed) parts.push("changed");
  else parts.push("ok");
  if (audit && !audit.noSubActive && !r.changed) parts.push("no-sub missing");
  return `${r.hostId}: ${parts.join(", ")}`;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {typeof import("node:child_process").spawnSync} opts.spawnSync
 * @returns {Promise<{ ok: boolean; results: AptSourcesHostResult[] }>}
 */
export async function runProxmoxAptSourcesMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, env, spawnSync } = opts;
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "APT sources maintain");
  if (!loaded) {
    return { ok: true, results: [] };
  }
  const cfg = loaded.data;

  if (!aptSourcesMaintainEnabledFromConfig(cfg)) {
    log("apt sources maintain: disabled in provision.apt_sources.enabled — skip.");
    return { ok: true, results: [] };
  }

  const options = aptSourcesOptionsFromConfig(cfg);
  const targets = listProxmoxHypervisorSshTargets(cfg, env);
  if (!targets.length) {
    warn("apt sources maintain: no clusters[].hosts[] with ssh:// URLs — skip.");
    return { ok: true, results: [] };
  }

  const { identities } = discoverLocalSshMaterial();
  const auditScript = buildAptSourcesAuditScript();

  log(
    `apt sources maintain: ${targets.length} hypervisor(s)${dryRun ? " [dry-run]" : ""} (no-subscription, disable enterprise, nag=${options.removeSubscriptionNag ? "yes" : "no"}).`,
  );

  /** @type {AptSourcesHostResult[]} */
  const results = [];
  let ok = true;

  for (const target of targets) {
    /** @type {AptSourcesHostResult} */
    const row = { hostId: target.id, major: null, changed: false, ok: true };

    if (!dryRun && !sshReachableWithPubkey(target, spawnSync, env, identities)) {
      ok = false;
      row.ok = false;
      row.error = "ssh unreachable";
      row.summary = formatAptSourcesHostSummary(row);
      results.push(row);
      warn(`[${target.id}] SSH public-key auth failed — skip apt sources.`);
      continue;
    }

    let major = pveMajorFromConfigCluster(cfg, target.clusterId);
    if (!major && !dryRun) {
      const verR = sshBashLc(target, "pveversion 2>/dev/null || pve version 2>/dev/null", {
        spawnSync,
        env,
        mode: "pubkey",
        identities,
        timeoutMs: 30_000,
      });
      const verOut = `${verR.stdout ?? ""}${verR.stderr ?? ""}`;
      const parsed = parsePveVersionFromCli(verOut);
      if (parsed && (parsed.major === 8 || parsed.major === 9)) major = parsed.major;
    }

    if (!major) {
      const relHint = target.clusterId ? ` (cluster ${target.clusterId})` : "";
      ok = false;
      row.ok = false;
      row.error = "unsupported or unknown PVE major";
      row.summary = formatAptSourcesHostSummary(row);
      results.push(row);
      warn(`[${target.id}] unsupported Proxmox version${relHint} — apt sources maintain supports PVE 8 and 9 only.`);
      continue;
    }

    row.major = major;
    const suite = debianSuiteForPveMajor(major);
    if (!suite) {
      ok = false;
      row.ok = false;
      row.error = "no debian suite mapping";
      results.push(row);
      continue;
    }

    if (dryRun) {
      log(`[${target.id}] dry-run: would audit and apply apt sources (PVE ${major}, ${suite}).`);
      row.changed = false;
      row.summary = formatAptSourcesHostSummary(row);
      results.push(row);
      continue;
    }

    log(`[${target.id}] auditing apt sources (PVE ${major}) …`);
    const auditR = sshBashLc(target, auditScript, {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 60_000,
    });
    if (auditR.status !== 0) {
      ok = false;
      row.ok = false;
      row.error = "audit failed";
      row.summary = formatAptSourcesHostSummary(row);
      results.push(row);
      warn(`[${target.id}] apt sources audit failed.`);
      continue;
    }

    const audit = parseAptSourcesAudit(`${auditR.stdout ?? ""}`, options);
    const applyScript = buildAptSourcesApplyScript({ major, suite, options });
    const shouldApply = audit.needsApply;

    if (!shouldApply) {
      log(`[${target.id}] apt sources and nag already configured.`);
      row.summary = formatAptSourcesHostSummary(row, audit);
      results.push(row);
      continue;
    }

    log(`[${target.id}] applying apt sources and subscription nag …`);
    const applyR = sshBashLc(target, applyScript, {
      spawnSync,
      env,
      mode: "pubkey",
      identities,
      timeoutMs: 600_000,
    });
    if (applyR.status !== 0) {
      ok = false;
      row.ok = false;
      row.error = "apply failed";
      row.summary = formatAptSourcesHostSummary(row);
      results.push(row);
      const err = `${applyR.stderr ?? ""}${applyR.stdout ?? ""}`.trim();
      warn(`[${target.id}] apt sources apply failed: ${err || "no output"}`);
      continue;
    }

    row.changed = /changed=1/.test(String(applyR.stdout ?? ""));
    log(`[${target.id}] apt sources ${row.changed ? "updated" : "unchanged"}.`);
    row.summary = formatAptSourcesHostSummary(row, audit);
    results.push(row);
  }

  return { ok, results };
}
