import { renderSatelliteCfSnippet } from "./postfix-relay-render.mjs";

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import("./postfix-relay-configure.mjs").ConfigureExec} exec
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
 * Configure Postfix as a satellite client forwarding to the internal hdc relay.
 *
 * @param {object} opts
 * @param {import("./postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {string} opts.relayhost Bracketed relay host, e.g. [192.0.2.60]
 * @param {string} opts.myhostname
 * @param {string} opts.myorigin
 * @param {string} [opts.inetInterfaces]
 */
export function configurePostfixSatellite(opts) {
  const { exec, log, relayhost, myhostname, myorigin } = opts;
  const inetInterfaces = opts.inetInterfaces?.trim() || "loopback-only";

  if (!relayhost.trim()) throw new Error("relayhost is required for satellite configure");

  const mainSnippet = renderSatelliteCfSnippet({
    relayhost,
    myhostname,
    myorigin,
    inetInterfaces,
  });

  runChecked(
    exec,
    "export DEBIAN_FRONTEND=noninteractive; " +
      "echo 'postfix postfix/mailname string " +
      myhostname.replace(/'/g, `'\\''`) +
      "' | debconf-set-selections; " +
      "echo 'postfix postfix/main_mailer_type string Satellite system' | debconf-set-selections; " +
      "apt-get update -qq && apt-get install -y postfix ca-certificates mailutils",
    log,
  );

  const mainB64 = Buffer.from(mainSnippet, "utf8").toString("base64");
  runChecked(exec, "mkdir -p /etc/postfix/main.cf.d", log);
  runChecked(
    exec,
    `echo ${shellQuote(mainB64)} | base64 -d > /etc/postfix/main.cf.d/hdc-satellite.cf`,
    log,
  );
  runChecked(
    exec,
    "sed -i '/^include \\/etc\\/postfix\\/main.cf.d/d' /etc/postfix/main.cf 2>/dev/null || true",
    log,
  );
  runChecked(
    exec,
    [
      `postconf -e ${shellQuote(`myhostname=${myhostname}`)}`,
      `postconf -e ${shellQuote(`myorigin=${myorigin}`)}`,
      `postconf -e ${shellQuote(`relayhost=${relayhost}`)}`,
      `postconf -e ${shellQuote(`inet_interfaces=${inetInterfaces}`)}`,
      "postconf -e 'mydestination='",
      "postconf -e 'local_transport=error:local delivery disabled on satellite'",
    ].join(" && "),
    log,
  );
  runChecked(exec, "postfix check && systemctl enable postfix && systemctl restart postfix", log);
  log.info(`Postfix satellite configured (relayhost ${relayhost}).`);

  return {
    ok: true,
    message: `Postfix satellite configured (${exec.label})`,
    details: { relayhost, myhostname, myorigin, inet_interfaces: inetInterfaces },
  };
}
