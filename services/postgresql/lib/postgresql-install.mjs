/**
 * @param {number} versionMajor
 */
export function aptInstallPostgresqlCommand(versionMajor) {
  const pkg = `postgresql-${versionMajor}`;
  return `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq ${pkg} postgresql-client-${versionMajor}`;
}

/**
 * @param {number} versionMajor
 */
export function postgresqlDataDir(versionMajor) {
  return `/var/lib/postgresql/${versionMajor}/main`;
}

/**
 * @param {number} versionMajor
 */
export function postgresqlConfDir(versionMajor) {
  return `/etc/postgresql/${versionMajor}/main`;
}
