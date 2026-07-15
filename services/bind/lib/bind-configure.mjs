import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import {
  renderNamedLocal,
  renderNamedLogging,
  renderNamedOptions,
  renderPrimaryZoneFiles,
  renderTsigKey,
  zoneFileName,
  TSIG_KEY_NAME,
} from "./bind-render.mjs";
import { buildZoneBundle, soaSerialFromTimestamp } from "./bind-zones.mjs";
import { syncDnscryptProxyOdoh } from "./bind-dnscrypt-configure.mjs";
import { ensureBindLogPurgeSchedule } from "./bind-log-purge.mjs";

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
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 100)}`);
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
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {string[]} opts.zoneIds
 * @param {Record<string, Record<string, unknown>>} opts.zoneDefinitions
 * @param {string} opts.primaryIp
 * @param {string} opts.secondaryIp
 * @param {string} opts.hostmaster
 * @param {string} [opts.serial] SOA serial (default: UTC timestamp YYYYMMDDHHmm).
 * @param {string} [opts.repoRoot] Repo root for cloudflare_fallback zone merge.
 */
export function syncPrimaryZoneFiles(opts) {
  const { exec, log, zoneIds, zoneDefinitions, primaryIp, secondaryIp, hostmaster } = opts;
  const serial = opts.serial ?? soaSerialFromTimestamp();

  runChecked(exec, "mkdir -p /var/lib/bind/zones", log);

  const apex =
    typeof hostmaster === "string" && hostmaster.includes(".")
      ? hostmaster.replace(/^[^.]+\./, "").replace(/\.$/, "")
      : "hdc.example.invalid";
  const primaryNs = `bind-a.${apex}.`;
  const secondaryNs = `bind-b.${apex}.`;
  const ns = { primaryNs, secondaryNs, primaryIp, secondaryIp, hostmaster };

  const { bundles } = buildZoneBundle(zoneIds, zoneDefinitions, ns, {
    serial,
    repoRoot: opts.repoRoot,
  });
  const zoneFiles = renderPrimaryZoneFiles({
    role: "primary",
    bundles,
    ns,
  });

  /** @type {{ zone: string; record_count: number; serial: string }[]} */
  const synced = [];
  for (const [zoneId, body] of Object.entries(zoneFiles)) {
    const file = zoneFileName(zoneId);
    const remotePath = `/var/lib/bind/zones/${file}.zone`;
    uploadFile(exec, remotePath, body, log);
    // Stale journals after a full zone rewrite cause "journal out of sync" on named restart.
    runChecked(exec, `rm -f ${shellQuote(`${remotePath}.jnl`)}`, log);
    const bundle = bundles.find((b) => b.id === zoneId);
    runChecked(exec, `named-checkzone ${shellQuote(zoneId)} ${shellQuote(remotePath)}`, log);
    synced.push({
      zone: zoneId,
      record_count: bundle?.records.length ?? 0,
      serial,
    });
    log.info(`${exec.label}: zone ${zoneId} — ${bundle?.records.length ?? 0} records, serial ${serial}`);
  }

  // Dynamic updates (RFC2136 / certbot dns-01) need bind to write .jnl journals in this directory.
  runChecked(
    exec,
    "chown bind:bind /var/lib/bind/zones /var/lib/bind/zones/*.zone && chmod 775 /var/lib/bind/zones",
    log,
  );

  // Full restart: rndc reload leaves stale in-memory zone data when allow-update is set.
  runChecked(exec, "systemctl restart named", log);

  return {
    ok: true,
    message: `BIND primary zones synced (${exec.label})`,
    details: { zones: synced.length, serial, zones_synced: synced },
  };
}

/**
 * Push named logging config (suppress security/query deny spam) and ensure named.conf include.
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 */
export function syncNamedLogging(opts) {
  const { exec, log } = opts;
  runChecked(exec, "mkdir -p /etc/bind/hdc", log);
  uploadFile(exec, "/etc/bind/hdc/logging.conf", renderNamedLogging(), log);
  runChecked(
    exec,
    `grep -q 'hdc/logging.conf' /etc/bind/named.conf 2>/dev/null || ` +
      `sed -i '1i include "/etc/bind/hdc/logging.conf";' /etc/bind/named.conf`,
    log,
  );
  return {
    ok: true,
    message: `BIND logging synced (${exec.label})`,
    details: { security_category: "null", queries_category: "null", query_errors_category: "null" },
  };
}

/**
 * Push named.conf.options from global BIND settings and reload named.
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {string[]} opts.allowQueryCidrs
 * @param {boolean} opts.recursion
 * @param {boolean} [opts.dnssecValidation]
 * @param {string[]} [opts.forwarders]
 */
export function syncNamedOptions(opts) {
  const { exec, log, allowQueryCidrs, recursion, dnssecValidation, forwarders } = opts;
  runChecked(exec, "mkdir -p /etc/bind/hdc", log);
  syncNamedLogging({ exec, log });
  const options = renderNamedOptions({
    allowQueryCidrs,
    recursion,
    dnssecValidation,
    forwarders,
  });
  uploadFile(exec, "/etc/bind/hdc/options.conf", options, log);
  runChecked(
    exec,
    `test -f /etc/bind/named.conf.options && grep -q 'hdc/options.conf' /etc/bind/named.conf.options || ` +
      `echo 'include "/etc/bind/hdc/options.conf";' > /etc/bind/named.conf.options`,
    log,
  );
  runChecked(exec, "named-checkconf", log);
  runChecked(exec, "rndc reload 2>/dev/null || systemctl reload named", log);
  return {
    ok: true,
    message: `BIND options synced (${exec.label})`,
    details: { forwarders: forwarders ?? [] },
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {"primary" | "secondary"} opts.role
 * @param {string[]} opts.zoneIds
 * @param {Record<string, Record<string, unknown>>} opts.zoneDefinitions
 * @param {string} opts.primaryIp
 * @param {string} opts.secondaryIp
 * @param {string} opts.hostmaster
 * @param {string} opts.tsigSecret
 * @param {string[]} opts.allowQueryCidrs
 * @param {boolean} opts.recursion
 * @param {boolean} [opts.dnssecValidation]
 * @param {string[]} [opts.forwarders]
 * @param {{ mode: string; server: string; relay: string; listen: string }} [opts.forwardUpstream]
 * @param {string} [opts.serial]
 * @param {string} [opts.repoRoot]
 */
export function configureBind(opts) {
  const {
    exec,
    log,
    role,
    zoneIds,
    zoneDefinitions,
    primaryIp,
    secondaryIp,
    hostmaster,
    tsigSecret,
    allowQueryCidrs,
    recursion,
    dnssecValidation,
    forwarders,
    forwardUpstream,
  } = opts;

  runChecked(
    exec,
    "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y bind9 bind9utils bind9-dnsutils",
    log,
  );

  runChecked(exec, "mkdir -p /var/lib/bind/zones /var/lib/bind/secondary", log);

  const dnscrypt =
    forwardUpstream && forwardUpstream.mode === "odoh"
      ? syncDnscryptProxyOdoh({ exec, log, forwardUpstream })
      : null;

  syncNamedOptions({
    exec,
    log,
    allowQueryCidrs,
    recursion,
    dnssecValidation,
    forwarders,
  });

  const tsig = renderTsigKey(tsigSecret);
  uploadFile(exec, "/etc/bind/hdc/tsig.key", tsig, log);
  runChecked(exec, "chmod 640 /etc/bind/hdc/tsig.key && chown root:bind /etc/bind/hdc/tsig.key", log);

  const local = renderNamedLocal({
    role,
    zoneIds,
    primaryIp,
    secondaryIp,
  });
  uploadFile(exec, "/etc/bind/hdc/local.conf", local, log);

  runChecked(
    exec,
    `test -f /etc/bind/named.conf.local && grep -q 'hdc/local.conf' /etc/bind/named.conf.local || ` +
      `echo 'include "/etc/bind/hdc/local.conf";' > /etc/bind/named.conf.local`,
    log,
  );
  runChecked(
    exec,
    `grep -q 'hdc/tsig.key' /etc/bind/named.conf 2>/dev/null || ` +
      `sed -i '1i include "/etc/bind/hdc/tsig.key";' /etc/bind/named.conf`,
    log,
  );

  let zoneSync = null;
  if (role === "primary") {
    zoneSync = syncPrimaryZoneFiles({
      exec,
      log,
      zoneIds,
      zoneDefinitions,
      primaryIp,
      secondaryIp,
      hostmaster,
      serial: opts.serial,
      repoRoot: opts.repoRoot,
    });
  }

  runChecked(exec, "named-checkconf", log);
  runChecked(exec, "systemctl enable named", log);
  runChecked(exec, "systemctl restart named", log);

  const logPurge = ensureBindLogPurgeSchedule({
    exec,
    log,
    systemId: opts.systemId,
    bindBlock: opts.bindBlock,
    flags: opts.flags,
  });

  return {
    ok: true,
    message: `BIND ${role} configured (${exec.label})`,
    details: {
      role,
      zones: zoneIds.length,
      tsig_key: TSIG_KEY_NAME,
      ...(dnscrypt?.details ? { dnscrypt_proxy: dnscrypt.details } : {}),
      ...(zoneSync?.details ? { zone_sync: zoneSync.details } : {}),
      log_purge: logPurge,
    },
  };
}
