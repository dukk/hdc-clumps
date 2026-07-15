import { stderr as errout } from "node:process";

/**
 * Splunk 9.4+ publishes linux-amd64.deb; older 9.x uses linux-2.6-amd64.deb.
 * @param {string} version
 */
function splunkDebArchSuffix(version) {
  const parts = version.trim().split(".").map((p) => Number.parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (major > 9 || (major === 9 && minor >= 4)) {
    return "linux-amd64";
  }
  return "linux-2.6-amd64";
}

/**
 * @param {string} version
 * @param {string} build
 */
export function splunkDebFilename(version, build) {
  const arch = splunkDebArchSuffix(version);
  return `splunk-${version}-${build}-${arch}.deb`;
}

/**
 * @param {string} version
 * @param {string} build
 */
export function splunkDownloadUrl(version, build) {
  const name = splunkDebFilename(version, build);
  return `https://download.splunk.com/products/splunk/releases/${version}/linux/${name}`;
}

/**
 * @param {object} opts
 * @param {string} opts.version
 * @param {string} opts.build
 * @param {string} opts.splunkHome
 * @param {string} [opts.downloadDir] staging dir for .deb (must have space; default /opt/splunk/var)
 */
export function buildSplunkInstallScript(opts) {
  const url = splunkDownloadUrl(opts.version, opts.build);
  const deb = splunkDebFilename(opts.version, opts.build);
  const home = opts.splunkHome;
  const dlDir =
    typeof opts.downloadDir === "string" && opts.downloadDir.trim()
      ? opts.downloadDir.trim()
      : "/opt/splunk/var";
  const versionKey = `${opts.version}-${opts.build}`;
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "ROOT_PART=$(findmnt -n -o SOURCE / | sed 's/[0-9]*$//')",
    "ROOT_NUM=$(findmnt -n -o SOURCE / | grep -oE '[0-9]+$')",
    'if [ -n "$ROOT_PART" ] && [ -n "$ROOT_NUM" ]; then',
    '  growpart "$ROOT_PART" "$ROOT_NUM" 2>/dev/null || true',
    '  resize2fs "$(findmnt -n -o SOURCE /)" 2>/dev/null || true',
    "fi",
    "apt-get update -qq",
    "apt-get install -y -qq curl ca-certificates acl cloud-guest-utils",
    `mkdir -p ${dlDir}/.hdc-install`,
    `rm -f /tmp/${deb} /var/tmp/${deb} 2>/dev/null || true`,
    `INSTALLED=$(cat ${home}/.hdc-version 2>/dev/null || true)`,
    `TARGET=${versionKey}`,
    'if [ "$INSTALLED" != "$TARGET" ]; then',
    `  DEB=${dlDir}/.hdc-install/${deb}`,
    `  curl -fL# -o "$DEB" ${url}`,
    `  dpkg -i "$DEB" || apt-get install -f -y -qq`,
    `  rm -f "$DEB"`,
    `  echo "$TARGET" > ${home}/.hdc-version`,
    "fi",
    `test -x ${home}/bin/splunk`,
    "",
  ].join("\n");
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {object} opts
 * @param {string} opts.version
 * @param {string} opts.build
 * @param {string} opts.splunkHome
 */
export async function installSplunkOnHost(exec, opts) {
  errout.write(`[hdc] splunk install: ${exec.label} …\n`);
  const script = buildSplunkInstallScript(opts);
  const r = exec.run(script);
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, message: detail };
  }
  errout.write(`[hdc] splunk install: completed on ${exec.label}.\n`);
  return { ok: true, message: "installed" };
}
