import { renderDnscryptProxyToml, MIN_DNSCRYPT_PROXY_VERSION } from "./bind-dnscrypt-render.mjs";

const DNSCRYPT_CONFIG_PATH = "/etc/dnscrypt-proxy/dnscrypt-proxy.toml";
/** GitHub release when distro package is below MIN_DNSCRYPT_PROXY_VERSION. */
const DNSCRYPT_PROXY_RELEASE = "2.1.16";
const DNSCRYPT_PROXY_ARCH = "linux_x86_64";
const DNSCRYPT_SYSTEMD_OVERRIDE = "/etc/systemd/system/dnscrypt-proxy.service.d/hdc-override.conf";

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {ReturnType<typeof import("./bind-configure.mjs").createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 100)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {ReturnType<typeof import("./bind-configure.mjs").createConfigureExec>} exec
 * @param {string} remotePath
 * @param {string} content
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function uploadFile(exec, remotePath, content, log) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`, log);
}

/**
 * Compare semver-like x.y.z strings; returns true if installed >= required.
 * @param {string} installed
 * @param {string} required
 */
function versionAtLeast(installed, required) {
  const a = installed.trim().split(".").map((n) => parseInt(n, 10) || 0);
  const b = required.trim().split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

/**
 * @param {string} raw
 */
function parseDnscryptVersion(raw) {
  const fromDpkg = raw.match(/^([12]\.\d+\.\d+)/);
  if (fromDpkg) return fromDpkg[1];
  const fromBinary = raw.match(/\b([12]\.\d+\.\d+)\b/);
  return fromBinary ? fromBinary[1] : "";
}

/**
 * @param {ReturnType<typeof import("./bind-configure.mjs").createConfigureExec>} exec
 */
function readDnscryptVersion(exec) {
  const local = exec.run("test -x /usr/local/bin/dnscrypt-proxy && /usr/local/bin/dnscrypt-proxy -version 2>/dev/null", {
    capture: true,
  });
  const fromLocal = parseDnscryptVersion(`${local.stdout}${local.stderr}`.trim());
  if (fromLocal) return fromLocal;
  const ver = exec.run("dnscrypt-proxy -version 2>/dev/null", { capture: true });
  const fromPath = parseDnscryptVersion(`${ver.stdout}${ver.stderr}`.trim());
  if (fromPath) return fromPath;
  const dpkg = exec.run(
    "dpkg-query -W -f='${Version}' dnscrypt-proxy 2>/dev/null | cut -d- -f1",
    { capture: true },
  );
  return parseDnscryptVersion(`${dpkg.stdout}`.trim());
}

/**
 * @param {ReturnType<typeof import("./bind-configure.mjs").createConfigureExec>} exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function installDnscryptProxyFromGithub(exec, log) {
  const tag = DNSCRYPT_PROXY_RELEASE;
  const arch = DNSCRYPT_PROXY_ARCH;
  const tarball = `dnscrypt-proxy-${arch}-${tag}.tar.gz`;
  const url = `https://github.com/DNSCrypt/dnscrypt-proxy/releases/download/${tag}/${tarball}`;
  runChecked(
    exec,
    [
      "set -e",
      `TAG=${shellQuote(tag)}`,
      `URL=${shellQuote(url)}`,
      "rm -rf /tmp/hdc-dnscrypt-install",
      "mkdir -p /tmp/hdc-dnscrypt-install",
      "cd /tmp/hdc-dnscrypt-install",
      'curl -fsSL "$URL" -o dnscrypt.tar.gz',
      "tar xzf dnscrypt.tar.gz",
      'BIN=$(find . -maxdepth 2 -type f -name dnscrypt-proxy | head -1)',
      'test -n "$BIN"',
      "install -m 755 \"$BIN\" /usr/local/bin/dnscrypt-proxy",
      "mkdir -p /etc/systemd/system/dnscrypt-proxy.service.d",
      `printf '%s\\n' '[Service]' 'ExecStart=' 'ExecStart=/usr/local/bin/dnscrypt-proxy -config ${DNSCRYPT_CONFIG_PATH}' > ${DNSCRYPT_SYSTEMD_OVERRIDE}`,
      "systemctl daemon-reload",
    ].join("\n"),
    log,
  );
  log.info(`${exec.label}: installed dnscrypt-proxy ${tag} from GitHub`);
}

/**
 * @param {ReturnType<typeof import("./bind-configure.mjs").createConfigureExec>} exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 * @param {{ skipApt?: boolean }} [opts]
 */
function ensureDnscryptProxyPackage(exec, log, opts = {}) {
  if (opts.skipApt) {
    const installed = readDnscryptVersion(exec);
    if (!installed || !versionAtLeast(installed, MIN_DNSCRYPT_PROXY_VERSION)) {
      throw new Error(
        `dnscrypt-proxy ${installed || "(missing)"} is below required ${MIN_DNSCRYPT_PROXY_VERSION} for ODoH (--skip-apt)`,
      );
    }
    log.info(`${exec.label}: dnscrypt-proxy ${installed} (--skip-apt)`);
    return;
  }
  runChecked(
    exec,
    "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y dnscrypt-proxy",
    log,
  );
  let installed = readDnscryptVersion(exec);
  if (!installed || !versionAtLeast(installed, MIN_DNSCRYPT_PROXY_VERSION)) {
    log.info(
      `${exec.label}: dnscrypt-proxy ${installed || "(missing)"} < ${MIN_DNSCRYPT_PROXY_VERSION}; installing ${DNSCRYPT_PROXY_RELEASE} from GitHub`,
    );
    installDnscryptProxyFromGithub(exec, log);
    installed = readDnscryptVersion(exec);
  }
  if (!installed || !versionAtLeast(installed, MIN_DNSCRYPT_PROXY_VERSION)) {
    throw new Error(
      `dnscrypt-proxy ${installed || "(unknown)"} is below required ${MIN_DNSCRYPT_PROXY_VERSION} for ODoH`,
    );
  }
  log.info(`${exec.label}: dnscrypt-proxy ${installed}`);
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./bind-configure.mjs").createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {{ mode: string; server: string; relay: string; listen: string }} opts.forwardUpstream
 * @param {boolean} [opts.skipApt]
 */
export function syncDnscryptProxyOdoh(opts) {
  const { exec, log, forwardUpstream, skipApt } = opts;
  if (forwardUpstream.mode !== "odoh") {
    return {
      ok: true,
      message: `dnscrypt-proxy skipped (${exec.label})`,
      details: { skipped: true },
    };
  }

  ensureDnscryptProxyPackage(exec, log, { skipApt });

  const toml = renderDnscryptProxyToml({
    listen: forwardUpstream.listen,
    server: forwardUpstream.server,
    relay: forwardUpstream.relay,
  });
  runChecked(exec, "mkdir -p /etc/dnscrypt-proxy", log);
  uploadFile(exec, DNSCRYPT_CONFIG_PATH, toml, log);
  runChecked(exec, "systemctl enable dnscrypt-proxy", log);
  runChecked(exec, "systemctl restart dnscrypt-proxy", log);

  const active = exec.run("systemctl is-active dnscrypt-proxy", { capture: true });
  if (!active.stdout.trim().includes("active")) {
    const journal = exec.run("journalctl -u dnscrypt-proxy -n 15 --no-pager 2>/dev/null", {
      capture: true,
    });
    const detail = `${journal.stdout}${journal.stderr}`.trim();
    throw new Error(
      `dnscrypt-proxy not active after restart (${exec.label})${detail ? `: ${detail.slice(-500)}` : ""}`,
    );
  }

  const listen = forwardUpstream.listen.trim();
  const lastColon = listen.lastIndexOf(":");
  const host = listen.slice(0, lastColon);
  const port = listen.slice(lastColon + 1);
  const probe = runChecked(
    exec,
    `dig @${host} -p ${port} cloudflare.com A +time=3 +tries=1 +short 2>/dev/null | head -1`,
    log,
  );
  const probeOut = probe.stdout.trim();
  if (!probeOut) {
    log.info(`${exec.label}: dnscrypt-proxy probe returned no A record (may still be warming up)`);
  }

  return {
    ok: true,
    message: `dnscrypt-proxy ODoH synced (${exec.label})`,
    details: {
      listen: forwardUpstream.listen,
      server: forwardUpstream.server,
      relay: forwardUpstream.relay,
      probe: probeOut || null,
    },
  };
}
