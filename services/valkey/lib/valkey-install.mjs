/**
 * @returns {string}
 */
export function aptInstallValkeyCommand() {
  return "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq valkey valkey-tools";
}

/**
 * @returns {string}
 */
export function aptUpgradeValkeyCommand() {
  return "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get upgrade -y -qq valkey valkey-tools";
}
