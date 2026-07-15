import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderMainCfSnippet,
  renderSaslPasswd,
  renderTransportMap,
  relayhostForSaslMap,
} from "./postfix-relay-render.mjs";
import { pctExec, qemuGuestExec, sshRemote } from "./remote.mjs";
import { createGuestSshExec } from "hdc/package/guest-ssh-exec.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";

/**
 * @typedef {object} ConfigureExec
 * @property {(inner: string, opts?: { capture?: boolean }) => { status: number; stdout: string; stderr: string }} run
 * @property {string} label Safe description for logs (no secrets).
 */

/**
 * @param {"pct" | "ssh" | "qemu-guest"} via
 * @param {{ user?: string; host: string; vmid?: number; pveHost?: string; useGuestSshFallback?: boolean; log?: (line: string) => void; env?: NodeJS.ProcessEnv }} target
 */
export function createConfigureExec(via, target) {
  if (via === "qemu-guest") {
    const vmid = target.vmid;
    const pveHost = target.pveHost ?? target.host;
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error("qemu-guest configure requires a positive numeric vmid");
    }
    if (!pveHost) {
      throw new Error("qemu-guest configure requires pveHost (Proxmox node SSH target)");
    }
    return /** @type {ConfigureExec} */ ({
      label: `qm guest exec ${vmid} on ${target.user}@${pveHost}`,
      run: (inner, opts) => qemuGuestExec(target.user, pveHost, Number(vmid), inner, opts),
    });
  }
  if (via === "pct") {
    const vmid = target.vmid;
    const pveHost = target.pveHost ?? target.host;
    if (!Number.isFinite(vmid) || vmid <= 0) {
      throw new Error("pct configure requires a positive numeric vmid");
    }
    const pveUser =
      typeof target.user === "string" && target.user.trim() ? target.user.trim() : "root";
    return /** @type {ConfigureExec} */ ({
      label: `pct exec ${vmid} on ${pveUser}@${pveHost}`,
      run: (inner, opts) => pctExec(pveUser, pveHost, Number(vmid), inner, opts),
    });
  }
  const configuredUser = resolveGuestSshUser(target.user, target.env);
  const guestExec = createGuestSshExec({
    host: target.host,
    configuredUser,
    env: target.env,
    useFallback: target.useGuestSshFallback !== false,
    log: target.log,
  });
  return /** @type {ConfigureExec} */ ({
    label: guestExec.label,
    run: guestExec.run,
  });
}

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {ConfigureExec} exec
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
 * @param {object} opts
 * @param {ConfigureExec} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {Record<string, unknown>} opts.postfix
 * @param {Record<string, unknown>} opts.smtp
 * @param {string} opts.smtpUser
 * @param {string} opts.smtpPass
 */
export function configurePostfixRelay(opts) {
  const { exec, log, postfix, smtp, smtpUser, smtpPass } = opts;

  const relayhost = typeof smtp.relayhost === "string" ? smtp.relayhost.trim() : "";
  if (!relayhost) throw new Error("smtp.relayhost is required");

  const myhostname =
    (typeof postfix.myhostname === "string" && postfix.myhostname.trim()) || "postfix-relay";
  const myorigin = (typeof postfix.myorigin === "string" && postfix.myorigin.trim()) || myhostname;
  const mynetworks =
    (typeof postfix.mynetworks === "string" && postfix.mynetworks.trim()) ||
    "127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128";
  const inetInterfaces =
    typeof postfix.inet_interfaces === "string" && postfix.inet_interfaces.trim()
      ? postfix.inet_interfaces.trim()
      : "all";
  const tlsLevel =
    typeof smtp.tls_security_level === "string" && smtp.tls_security_level.trim()
      ? smtp.tls_security_level.trim()
      : "encrypt";

  /** @type {{ domain: string, nexthop: string }[]} */
  const transportEntries = [];
  const rawTransport = postfix.transport;
  if (Array.isArray(rawTransport)) {
    for (const row of rawTransport) {
      if (!row || typeof row !== "object") continue;
      const domain = typeof row.domain === "string" ? row.domain.trim() : "";
      const nexthop = typeof row.nexthop === "string" ? row.nexthop.trim() : "";
      if (domain && nexthop) transportEntries.push({ domain, nexthop });
    }
  }

  const mainSnippet = renderMainCfSnippet({
    relayhost,
    tlsSecurityLevel: tlsLevel,
    myhostname,
    myorigin,
    mynetworks,
    inetInterfaces,
    transport: transportEntries,
  });
  const saslBody = renderSaslPasswd(relayhostForSaslMap(relayhost), smtpUser, smtpPass);
  const transportBody = renderTransportMap(transportEntries);

  const tmp = mkdtempSync(join(tmpdir(), "hdc-postfix-relay-"));
  const localMain = join(tmp, "hdc-relay.cf");
  const localSasl = join(tmp, "sasl_passwd");
  try {
    writeFileSync(localMain, mainSnippet, "utf8");
    writeFileSync(localSasl, saslBody, "utf8");
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }

  try {
    runChecked(
      exec,
      "export DEBIAN_FRONTEND=noninteractive; " +
        "echo 'postfix postfix/mailname string " +
        myhostname.replace(/'/g, `'\\''`) +
        "' | debconf-set-selections; " +
        "echo 'postfix postfix/main_mailer_type string Satellite system' | debconf-set-selections; " +
        "apt-get update -qq && apt-get install -y postfix libsasl2-modules ca-certificates",
      log,
    );

    const mainB64 = Buffer.from(mainSnippet, "utf8").toString("base64");
    const saslB64 = Buffer.from(saslBody, "utf8").toString("base64");
    runChecked(exec, "mkdir -p /etc/postfix/main.cf.d", log);
    runChecked(
      exec,
      `echo ${shellQuote(mainB64)} | base64 -d > /etc/postfix/main.cf.d/hdc-relay.cf`,
      log,
    );
    runChecked(
      exec,
      `echo ${shellQuote(saslB64)} | base64 -d > /etc/postfix/sasl_passwd && chmod 600 /etc/postfix/sasl_passwd`,
      log,
    );
    runChecked(exec, "postmap /etc/postfix/sasl_passwd", log);
    log.info("postmap wrote /etc/postfix/sasl_passwd.db");
    if (transportEntries.length) {
      const transportB64 = Buffer.from(transportBody, "utf8").toString("base64");
      runChecked(
        exec,
        `echo ${shellQuote(transportB64)} | base64 -d > /etc/postfix/transport && chmod 644 /etc/postfix/transport`,
        log,
      );
      runChecked(exec, "postmap /etc/postfix/transport", log);
      log.info(`postmap wrote /etc/postfix/transport.db (${transportEntries.length} domain route(s))`);
    }
    runChecked(
      exec,
      "sed -i '/^include \\/etc\\/postfix\\/main.cf.d/d' /etc/postfix/main.cf 2>/dev/null || true",
      log,
    );
    const postconfCmds = [
      `postconf -e ${shellQuote(`myhostname=${myhostname}`)}`,
      `postconf -e ${shellQuote(`myorigin=${myorigin}`)}`,
      `postconf -e ${shellQuote(`mynetworks=${mynetworks}`)}`,
      `postconf -e ${shellQuote(`inet_interfaces=${inetInterfaces}`)}`,
      `postconf -e ${shellQuote(`relayhost=${relayhost}`)}`,
      "postconf -e 'smtp_sasl_auth_enable=yes'",
      "postconf -e 'smtp_sasl_password_maps=hash:/etc/postfix/sasl_passwd'",
      "postconf -e 'smtp_sasl_security_options=noanonymous'",
      "postconf -e 'smtp_sasl_tls_security_options=noanonymous'",
      "postconf -e 'smtp_use_tls=yes'",
      `postconf -e ${shellQuote(`smtp_tls_security_level=${tlsLevel}`)}`,
      "postconf -e 'smtp_tls_CAfile=/etc/ssl/certs/ca-certificates.crt'",
    ];
    if (transportEntries.length) {
      postconfCmds.push("postconf -e 'transport_maps=hash:/etc/postfix/transport'");
    }
    runChecked(exec, postconfCmds.join(" && "), log);
    runChecked(
      exec,
      "postfix check && systemctl enable postfix && systemctl restart postfix",
      log,
    );
    log.info("Postfix relay configured (SMTP2GO smarthost) and reloaded.");
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    message: `Postfix relay configured (${exec.label})`,
    details: { relayhost, myhostname, myorigin },
  };
}
