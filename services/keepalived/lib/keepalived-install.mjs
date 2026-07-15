export const KEEPALIVED_CONF_PATH = "/etc/keepalived/keepalived.conf";

/**
 * Install keepalived and ipvsadm on Ubuntu/Debian.
 */
export function aptInstallKeepalivedCommand() {
  return `export DEBIAN_FRONTEND=noninteractive
set -e
apt-get update -qq
apt-get install -y -qq --no-install-recommends keepalived ipvsadm`;
}

/**
 * Optional apt upgrade for keepalived packages.
 */
export function aptUpgradeKeepalivedCommand() {
  return `export DEBIAN_FRONTEND=noninteractive
set -e
apt-get update -qq
apt-get install -y -qq --only-upgrade keepalived ipvsadm || true`;
}
