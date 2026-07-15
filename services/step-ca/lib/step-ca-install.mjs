/**
 * Install Smallstep apt repository and step-cli / step-ca packages.
 */
export function aptInstallStepCaCommand() {
  return `export DEBIAN_FRONTEND=noninteractive
set -e
if ! test -f /etc/apt/keyrings/smallstep.asc; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends curl gpg ca-certificates
  curl -fsSL https://packages.smallstep.com/keys/apt/repo-signing-key.gpg -o /etc/apt/keyrings/smallstep.asc
  printf '%s\n' 'Types: deb' 'URIs: https://packages.smallstep.com/stable/debian' 'Suites: debs' 'Components: main' 'Signed-By: /etc/apt/keyrings/smallstep.asc' > /etc/apt/sources.list.d/smallstep.sources
fi
apt-get update -qq
apt-get install -y -qq step-cli step-ca`;
}

/**
 * @param {string} stepPath e.g. /etc/step-ca
 */
export function caConfigPath(stepPath) {
  return `${stepPath.replace(/\/$/, "")}/config/ca.json`;
}

/**
 * @param {string} stepPath
 */
export function caPasswordPath(stepPath) {
  return `${stepPath.replace(/\/$/, "")}/password.txt`;
}
