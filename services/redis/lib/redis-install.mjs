/**
 * @returns {string}
 */
export function aptInstallRedisCommand() {
  return "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq redis-server redis-tools";
}

/**
 * @returns {string}
 */
export function aptUpgradeRedisCommand() {
  return "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get upgrade -y -qq redis-server redis-tools";
}
