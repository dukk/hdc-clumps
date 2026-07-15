import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  renderHdcPgHbaConf,
  renderHdcPostgresqlConf,
  replicationHbaLine,
} from "./postgresql-render.mjs";
import {
  aptInstallPostgresqlCommand,
  postgresqlConfDir,
  postgresqlDataDir,
} from "./postgresql-install.mjs";

export { createConfigureExec };

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 120)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} remotePath
 * @param {string} content
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function uploadFile(exec, remotePath, content, log) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`, log);
}

/**
 * @param {string} password
 */
function sqlEscapeLiteral(password) {
  return password.replace(/'/g, "''");
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {number} opts.versionMajor
 * @param {string} opts.superuserPassword
 * @param {string[]} opts.listenCidrs
 * @param {string} opts.listenAddresses
 * @param {boolean} opts.replicationEnabled
 * @param {string} opts.replicationUser
 * @param {string} opts.replicationPassword
 * @param {string[]} opts.standbyHostIps
 * @param {unknown[]} opts.databases
 * @param {unknown[]} opts.roles
 * @param {(key: string, label: string) => Promise<string>} [opts.resolveRolePassword]
 */
export async function configurePostgresqlServer(opts) {
  const {
    exec,
    log,
    versionMajor,
    superuserPassword,
    listenCidrs,
    listenAddresses,
    replicationEnabled,
    replicationUser,
    replicationPassword,
    standbyHostIps,
    databases,
    roles,
    resolveRolePassword,
  } = opts;

  const confDir = postgresqlConfDir(versionMajor);
  const dataDir = postgresqlDataDir(versionMajor);

  runChecked(exec, aptInstallPostgresqlCommand(versionMajor), log);
  runChecked(exec, `mkdir -p ${confDir}/conf.d`, log);

  const replicationLines = replicationEnabled
    ? standbyHostIps.map((ip) => replicationHbaLine(replicationUser, ip))
    : [];
  uploadFile(exec, `${confDir}/conf.d/hdc-postgresql.conf`, renderHdcPostgresqlConf({
    listenAddresses,
    replicationEnabled,
  }), log);
  const hbaRulesPath = `${confDir}/hdc-pg_hba.rules`;
  uploadFile(exec, hbaRulesPath, renderHdcPgHbaConf(listenCidrs, replicationLines), log);

  runChecked(
    exec,
    `grep -q 'hdc-postgresql.conf' ${confDir}/postgresql.conf || ` +
      `echo "include '${confDir}/conf.d/hdc-postgresql.conf'" >> ${confDir}/postgresql.conf`,
    log,
  );
  runChecked(
    exec,
    `grep -q 'hdc-pg_hba.rules' ${confDir}/pg_hba.conf || ` +
      `echo "include ${hbaRulesPath}" >> ${confDir}/pg_hba.conf`,
    log,
  );
  runChecked(
    exec,
    `rm -f ${confDir}/conf.d/hdc-pg_hba.conf`,
    log,
  );

  const suEsc = sqlEscapeLiteral(superuserPassword);
  runChecked(
    exec,
    `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER USER postgres PASSWORD '${suEsc}';"`,
    log,
  );

  if (replicationEnabled && replicationPassword) {
    const repEsc = sqlEscapeLiteral(replicationPassword);
    runChecked(
      exec,
      `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DO \\$\\$ BEGIN ` +
        `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${replicationUser.replace(/'/g, "''")}') THEN ` +
        `CREATE ROLE ${replicationUser} WITH REPLICATION LOGIN PASSWORD '${repEsc}'; ` +
        `ELSE ALTER ROLE ${replicationUser} WITH REPLICATION LOGIN PASSWORD '${repEsc}'; END IF; END \\$\\$;"`,
      log,
    );
  }

  if (resolveRolePassword) {
    for (const raw of roles) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const r = /** @type {Record<string, unknown>} */ (raw);
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const vaultKey =
        typeof r.password_vault_key === "string" ? r.password_vault_key.trim() : "";
      if (!name || !vaultKey) continue;
      const pw = sqlEscapeLiteral(await resolveRolePassword(vaultKey, name));
      runChecked(
        exec,
        `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DO \\$\\$ BEGIN ` +
          `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name.replace(/'/g, "''")}') THEN ` +
          `CREATE ROLE ${name} WITH LOGIN PASSWORD '${pw}'; ` +
          `ELSE ALTER ROLE ${name} WITH LOGIN PASSWORD '${pw}'; END IF; END \\$\\$;"`,
        log,
      );
    }
  }

  for (const raw of databases) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const db = /** @type {Record<string, unknown>} */ (raw);
    const name = typeof db.name === "string" ? db.name.trim() : "";
    const owner = typeof db.owner === "string" ? db.owner.trim() : "";
    if (!name) continue;
    const ownerFlag = owner ? ` -O ${owner}` : "";
    runChecked(
      exec,
      `sudo -u postgres psql -v ON_ERROR_STOP=1 -tc "SELECT 1 FROM pg_database WHERE datname='${name.replace(/'/g, "''")}'" | grep -q 1 || ` +
        `sudo -u postgres createdb${ownerFlag} ${name}`,
      log,
    );
  }

  runChecked(exec, "systemctl enable postgresql", log);
  runChecked(exec, "systemctl restart postgresql", log);

  return {
    ok: true,
    message: `PostgreSQL configured (${exec.label})`,
    details: { version_major: versionMajor, data_dir: dataDir, replication: replicationEnabled },
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {number} opts.versionMajor
 * @param {string} opts.primaryHost
 * @param {string} opts.replicationUser
 * @param {string} opts.replicationPassword
 */
export async function configurePostgresqlStandby(opts) {
  const { exec, log, versionMajor, primaryHost, replicationUser, replicationPassword } = opts;
  const confDir = postgresqlConfDir(versionMajor);
  const dataDir = postgresqlDataDir(versionMajor);

  runChecked(exec, aptInstallPostgresqlCommand(versionMajor), log);
  runChecked(exec, "systemctl stop postgresql", log);

  const pwFile = "/root/.pgpass.hdc-replication";
  const pgpassLine = `${primaryHost}:5432:replication:${replicationUser}:${replicationPassword}`;
  const b64 = Buffer.from(pgpassLine, "utf8").toString("base64");
  runChecked(
    exec,
    `echo ${shellQuote(b64)} | base64 -d > ${pwFile} && chmod 600 ${pwFile}`,
    log,
  );

  runChecked(
    exec,
    `rm -rf ${dataDir}/* && ` +
      `PGPASSFILE=${pwFile} pg_basebackup -h ${shellQuote(primaryHost)} -U ${replicationUser} ` +
      `-D ${dataDir} -Fp -Xs -P -R`,
    log,
  );
  runChecked(exec, `touch ${dataDir}/standby.signal`, log);
  runChecked(exec, `chown -R postgres:postgres ${dataDir}`, log);
  runChecked(
    exec,
    `test -f ${confDir}/postgresql.conf || true`,
    log,
  );
  runChecked(exec, "systemctl enable postgresql", log);
  runChecked(exec, "systemctl start postgresql", log);

  return {
    ok: true,
    message: `PostgreSQL standby configured from ${primaryHost} (${exec.label})`,
    details: { version_major: versionMajor, primary_host: primaryHost },
  };
}
