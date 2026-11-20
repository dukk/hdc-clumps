import { readFileSync } from "node:fs";
import { env, stderr as errout } from "node:process";

import { resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { spawnSync } from "node:child_process";
import { tlsCertName, tlsCertDir, tlsEnabled, tlsRootCaPath, tlsCertSource } from "./mosquitto-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} value
 */
function parseIpv4FromCidr(value) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})/.exec(String(value ?? "").trim());
  return m ? m[1] : null;
}

/**
 * @param {Record<string, unknown>} cfg
 */
function caHostFromStepCaConfig(cfg) {
  const deployments = Array.isArray(cfg.deployments) ? cfg.deployments : [];
  for (const d of deployments) {
    if (!isObject(d)) continue;
    const configure = isObject(d.configure) ? d.configure : {};
    const ssh = isObject(configure.ssh) ? configure.ssh : {};
    const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
    if (host) return host;
    const px = isObject(d.proxmox) ? d.proxmox : {};
    const qemu = isObject(px.qemu) ? px.qemu : {};
    const ip = parseIpv4FromCidr(qemu.ip);
    if (ip) return ip;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} mosquitto
 * @param {string} [configPathOverride]
 */
export function resolveStepCaSettings(mosquitto, configPathOverride) {
  const tls = isObject(mosquitto.tls) ? mosquitto.tls : {};
  const rel =
    (typeof tls.step_ca_config_path === "string" && tls.step_ca_config_path.trim()) ||
    configPathOverride ||
    "clumps/services/step-ca/config.json";
  const resolved = resolveRepoFile(repoRoot(), rel);
  if (!resolved.found) {
    throw new Error(`step-ca config not found at ${rel}`);
  }
  errout.write(`[hdc] mosquitto tls: step-ca config from ${resolved.source} ${resolved.rel}\n`);
  const cfg = JSON.parse(readFileSync(resolved.path, "utf8"));
  if (!isObject(cfg)) {
    throw new Error("step-ca config must be a JSON object");
  }
  const stepCa = isObject(cfg.step_ca) ? cfg.step_ca : {};
  const dnsNames = Array.isArray(stepCa.dns_names) ? stepCa.dns_names : [];
  const dnsName = typeof dnsNames[0] === "string" ? dnsNames[0].trim() : "";
  if (!dnsName) {
    throw new Error("step_ca.dns_names[0] required in step-ca config");
  }
  if (stepCa.enable_acme === false) {
    throw new Error("step-ca ACME must be enabled for mosquitto TLS bootstrap");
  }
  const tlsHostOverride =
    typeof tls.step_ca_host === "string" && tls.step_ca_host.trim() ? tls.step_ca_host.trim() : "";
  const caHost = tlsHostOverride || caHostFromStepCaConfig(cfg) || dnsName;
  const acmeBase = `https://${dnsName}`;
  const acmeServer = `${acmeBase}/acme/acme/directory`;
  const rootUrl =
    caHost !== dnsName ? `https://${caHost}/roots.pem` : `${acmeBase}/roots.pem`;
  if (caHost !== dnsName) {
    errout.write(`[hdc] mosquitto tls: root fetch via ${caHost}; ACME via ${dnsName}\n`);
  }
  return {
    dnsName,
    caHost,
    acmeServer,
    rootUrl,
    rootCaPath: tlsRootCaPath(mosquitto),
    configSource: resolved.source,
  };
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function resolveAcmeEmail(mosquitto) {
  const tls = isObject(mosquitto.tls) ? mosquitto.tls : {};
  const fromConfig = typeof tls.acme_email === "string" ? tls.acme_email.trim() : "";
  if (fromConfig) return fromConfig;
  const envKey =
    typeof tls.acme_email_env === "string" && tls.acme_email_env.trim()
      ? tls.acme_email_env.trim()
      : "HDC_MOSQUITTO_ACME_EMAIL";
  const fromEnv = env[envKey]?.trim() || env.HDC_NGINX_LE_EMAIL?.trim() || env.HDC_NGINX_WAF_LETS_ENCRYPT_EMAIL?.trim() || "";
  if (!fromEnv) {
    throw new Error(
      `ACME email required — set mosquitto.tls.acme_email or ${envKey} (or HDC_NGINX_LE_EMAIL) in .env`,
    );
  }
  return fromEnv;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} mosquitto
 */
export const MOSQUITTO_CERT_RECEIVER = "/usr/local/sbin/hdc-mosquitto-certs";
export const MOSQUITTO_DISTRIBUTE_KEY_COMMENT = "hdc-nginx-waf-certs-distribute";

/**
 * @param {string} text
 */
function parseJsonc(text) {
  return JSON.parse(String(text).replace(/^\s*\/\/.*$/gm, ""));
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function resolveNginxWafConfig(mosquitto) {
  const tls = isObject(mosquitto.tls) ? mosquitto.tls : {};
  const rel =
    (typeof tls.nginx_waf_config_path === "string" && tls.nginx_waf_config_path.trim()) ||
    "clumps/services/nginx-waf/config.json";
  const resolved = resolveRepoFile(repoRoot(), rel);
  if (!resolved.found) {
    throw new Error(`nginx-waf config not found at ${rel}`);
  }
  const cfg = parseJsonc(readFileSync(resolved.path, "utf8"));
  if (!isObject(cfg)) throw new Error("nginx-waf config must be a JSON object");
  return { cfg, source: resolved.source, rel: resolved.rel };
}

/**
 * Peer public key and WAF LAN addresses from the nginx-waf clump config.
 * @param {Record<string, unknown>} mosquitto
 * @returns {{ publicKey: string, fromHosts: string[], wafSsh: { host: string, user: string }[] }}
 */
export function resolveWafDistributeSettings(mosquitto) {
  const { cfg } = resolveNginxWafConfig(mosquitto);
  const groups = Array.isArray(cfg.deployment_groups) ? cfg.deployment_groups : [];
  /** @type {string} */
  let publicKey = "";
  /** @type {string[]} */
  const fromHosts = [];
  /** @type {{ host: string, user: string }[]} */
  const wafSsh = [];
  for (const g of groups) {
    if (!isObject(g)) continue;
    const acme = isObject(g.acme) ? g.acme : {};
    const ha = isObject(acme.cert_ha) ? acme.cert_ha : {};
    if (!publicKey && typeof ha.peer_ssh_public_key === "string") {
      publicKey = ha.peer_ssh_public_key.trim();
    }
    const deployments = Array.isArray(g.deployments) ? g.deployments : [];
    for (const d of deployments) {
      if (!isObject(d)) continue;
      const configure = isObject(d.configure) ? d.configure : {};
      const ssh = isObject(configure.ssh) ? configure.ssh : {};
      const sshHost = typeof ssh.host === "string" ? ssh.host.trim() : "";
      const sshUser = typeof ssh.user === "string" && ssh.user.trim() ? ssh.user.trim() : "hdc";
      const px = isObject(d.proxmox) ? d.proxmox : {};
      const qemu = isObject(px.qemu) ? px.qemu : {};
      const ip = parseIpv4FromCidr(qemu.ip);
      const host = ip || sshHost;
      if (host) {
        if (!fromHosts.includes(host)) fromHosts.push(host);
        if (sshHost || ip) wafSsh.push({ host: sshHost || host, user: sshUser });
      }
    }
  }
  if (!publicKey) {
    throw new Error("nginx-waf acme.cert_ha.peer_ssh_public_key required to receive certs from the WAFs");
  }
  return { publicKey, fromHosts, wafSsh };
}

/**
 * authorized_keys line: same peer key as the WAF fleet, forced to the mosquitto receiver.
 * @param {string} publicKey
 * @param {string[]} fromHosts
 */
export function renderMosquittoDistributeAuthorizedKey(publicKey, fromHosts, options = {}) {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !/^ssh-(ed25519|rsa)$|^ecdsa-/.test(parts[0])) {
    throw new Error("cert_ha.peer_ssh_public_key must be an OpenSSH public key");
  }
  for (const h of fromHosts) {
    if (!/^[A-Za-z0-9.\-:*]+$/.test(h)) throw new Error(`bad WAF host ${JSON.stringify(h)}`);
  }
  const receiveCmd = options.viaSudo
    ? `sudo -n ${MOSQUITTO_CERT_RECEIVER} receive`
    : `${MOSQUITTO_CERT_RECEIVER} receive`;
  const opts = [
    `command="${receiveCmd}"`,
    "no-pty",
    "no-port-forwarding",
    "no-agent-forwarding",
    "no-X11-forwarding",
    fromHosts.length ? `from="${fromHosts.join(",")}"` : "",
  ].filter(Boolean);
  return `${opts.join(",")} ${parts[0]} ${parts[1]} ${MOSQUITTO_DISTRIBUTE_KEY_COMMENT}`;
}

export function renderMosquittoCertReceiverScript() {
  return `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" != "receive" ]; then
  echo "usage: receive" >&2
  exit 2
fi
dest=/etc/mosquitto/certs
stage=\$(mktemp -d)
trap 'rm -rf "\$stage"' EXIT
cat > "\$stage/in.tar"
tar -C "\$stage" -xf "\$stage/in.tar"
rm -f "\$stage/in.tar"
for f in fullchain.pem privkey.pem; do
  if [ -L "\$stage/\$f" ]; then
    cp -L "\$stage/\$f" "\$stage/\$f.real"
    mv "\$stage/\$f.real" "\$stage/\$f"
  fi
  test -f "\$stage/\$f" && test -s "\$stage/\$f"
done
install -d -m 750 -o mosquitto -g mosquitto "\$dest"
install -m 640 -o mosquitto -g mosquitto "\$stage/fullchain.pem" "\$dest/fullchain.pem"
install -m 640 -o mosquitto -g mosquitto "\$stage/privkey.pem" "\$dest/privkey.pem"
systemctl reload mosquitto 2>/dev/null || systemctl restart mosquitto
`;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} mosquitto
 */
export function installMosquittoCertReceiver(exec, mosquitto) {
  const { publicKey, fromHosts } = resolveWafDistributeSettings(mosquitto);
  const rootLine = renderMosquittoDistributeAuthorizedKey(publicKey, fromHosts);
  const hdcLine = renderMosquittoDistributeAuthorizedKey(publicKey, fromHosts, { viaSudo: true });
  const scriptB64 = Buffer.from(renderMosquittoCertReceiverScript(), "utf8").toString("base64");
  const rootLineB64 = Buffer.from(`${rootLine}\n`, "utf8").toString("base64");
  const hdcLineB64 = Buffer.from(`${hdcLine}\n`, "utf8").toString("base64");
  const cmd = [
    "set -euo pipefail",
    `echo ${shellQuote(scriptB64)} | base64 -d > ${MOSQUITTO_CERT_RECEIVER}`,
    `chmod 755 ${MOSQUITTO_CERT_RECEIVER}`,
    "install_key() {",
    "  F=$1; owner=$2; b64=$3",
    '  install -d -m 700 -o "$owner" -g "$owner" "$(dirname "$F")"',
    '  touch "$F" && chmod 600 "$F" && chown "$owner:$owner" "$F"',
    "  grep -v " + shellQuote(MOSQUITTO_DISTRIBUTE_KEY_COMMENT) + ' "$F" > "$F.tmp" || true',
    '  echo "$b64" | base64 -d >> "$F.tmp"',
    '  mv "$F.tmp" "$F" && chmod 600 "$F" && chown "$owner:$owner" "$F"',
    "}",
    `install_key /root/.ssh/authorized_keys root ${shellQuote(rootLineB64)}`,
    `id hdc >/dev/null 2>&1 && install_key /home/hdc/.ssh/authorized_keys hdc ${shellQuote(hdcLineB64)} || true`,
  ].join("\n");
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`failed to install mosquitto cert receiver: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
}

/**
 * Stop the legacy guest certbot / step-ca renew timer so it cannot keep failing against ca.hdc.
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function retireGuestCertbotTimers(exec) {
  const cmd = [
    "systemctl disable --now hdc-mosquitto-cert-renew.timer certbot.timer 2>/dev/null || true",
    "systemctl mask hdc-mosquitto-cert-renew.timer certbot.timer 2>/dev/null || true",
    "systemctl disable --now hdc-mosquitto-cert-renew.service certbot.service 2>/dev/null || true",
  ].join("\n");
  exec.run(cmd, { capture: true });
}

/**
 * Fetch live pems from a WAF (operator SSH as the existing hdc user).
 * @param {string} host
 * @param {string} user
 * @param {string} certName
 * @returns {{ ok: boolean, tar?: Buffer, message?: string }}
 */
export function fetchLivePemTarFromWaf(host, user, certName) {
  const safe = String(certName).replace(/[^a-zA-Z0-9._-]/g, "");
  const remote = `sudo -n tar -C /etc/letsencrypt/live/${safe} -chf - fullchain.pem privkey.pem`;
  const r = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "IdentitiesOnly=no", `${user}@${host}`, remote],
    { encoding: "buffer", maxBuffer: 2_000_000 },
  );
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || Buffer.from(`exit ${r.status}`)).toString("utf8").trim();
    return { ok: false, message: err.slice(0, 300) };
  }
  if (!r.stdout || !r.stdout.length) return { ok: false, message: "empty tar from WAF" };
  return { ok: true, tar: r.stdout };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Buffer} tarBuf
 * @param {string} dest
 */
export function installPemTarOnGuest(exec, tarBuf, dest) {
  const b64 = tarBuf.toString("base64");
  const cmd = [
    "set -euo pipefail",
    "stage=$(mktemp -d)",
    "trap 'rm -rf \"$stage\"' EXIT",
    `echo ${shellQuote(b64)} | base64 -d | tar -C "$stage" -xf -`,
    "for f in fullchain.pem privkey.pem; do",
    '  if [ -L "$stage/$f" ]; then cp -L "$stage/$f" "$stage/$f.real" && mv "$stage/$f.real" "$stage/$f"; fi',
    '  test -f "$stage/$f" && test -s "$stage/$f"',
    "done",
    `install -d -m 750 -o mosquitto -g mosquitto ${shellQuote(dest)}`,
    `install -m 640 -o mosquitto -g mosquitto "$stage/fullchain.pem" ${shellQuote(dest)}/fullchain.pem`,
    `install -m 640 -o mosquitto -g mosquitto "$stage/privkey.pem" ${shellQuote(dest)}/privkey.pem`,
    "systemctl reload mosquitto 2>/dev/null || systemctl restart mosquitto",
  ].join("\n");
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`failed to install MQTTS cert: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} dest
 */
export function guestMqttCertIsLetsEncrypt(exec, dest) {
  const path = `${dest}/fullchain.pem`;
  const exists = exec.run(`test -s ${shellQuote(path)}`, { capture: true });
  if (exists.status !== 0) return false;
  const valid = exec.run(`openssl x509 -in ${shellQuote(path)} -noout -checkend 0`, { capture: true });
  if (valid.status !== 0) return false;
  const issuer = exec.run(`openssl x509 -in ${shellQuote(path)} -noout -issuer`, { capture: true });
  return /Let's Encrypt|ISRG/i.test(issuer.stdout || "");
}

/**
 * Install receiver, retire guest ACME timers, and copy the WAF-issued cert onto mosquitto.
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {Record<string, unknown>} opts.mosquitto
 */
export function ensureTlsFromNginxWaf(opts) {
  const { exec, mosquitto } = opts;
  const certName = tlsCertName(mosquitto);
  const dest = tlsCertDir(mosquitto);
  installMosquittoCertReceiver(exec, mosquitto);
  retireGuestCertbotTimers(exec);
  const { wafSsh } = resolveWafDistributeSettings(mosquitto);
  /** @type {string[]} */
  const errors = [];
  for (const waf of wafSsh) {
    const fetched = fetchLivePemTarFromWaf(waf.host, waf.user, certName);
    if (!fetched.ok) {
      errors.push(`${waf.user}@${waf.host}: ${fetched.message}`);
      continue;
    }
    installPemTarOnGuest(exec, fetched.tar, dest);
    errout.write(`[hdc] mosquitto tls: installed ${certName} from ${waf.user}@${waf.host}\n`);
    return { ok: true, cert_name: certName, source: "nginx-waf", from: `${waf.user}@${waf.host}` };
  }
  if (guestMqttCertIsLetsEncrypt(exec, dest)) {
    errout.write(`[hdc] mosquitto tls: existing Let's Encrypt cert at ${dest} is still valid\n`);
    return { ok: true, cert_name: certName, source: "nginx-waf", skipped: true, message: "valid LE cert already present" };
  }
  throw new Error(
    `could not copy ${certName} from the WAF fleet onto mosquitto (run nginx-waf maintain first): ${errors.join("; ") || "no WAF hosts"}`,
  );
}


export function syncTlsCertsForMosquitto(exec, mosquitto) {
  const certName = tlsCertName(mosquitto).replace(/[^a-zA-Z0-9._-]/g, "");
  const dest = tlsCertDir(mosquitto);
  const src = `/etc/letsencrypt/live/${certName}`;
  const cmd = [
    "set -euo pipefail",
    `test -f ${src}/fullchain.pem`,
    `install -d -m 750 -o mosquitto -g mosquitto ${shellQuote(dest)}`,
    `cp -L ${src}/fullchain.pem ${shellQuote(dest)}/fullchain.pem`,
    `cp -L ${src}/privkey.pem ${shellQuote(dest)}/privkey.pem`,
    `chown mosquitto:mosquitto ${shellQuote(dest)}/fullchain.pem ${shellQuote(dest)}/privkey.pem`,
    `chmod 640 ${shellQuote(dest)}/fullchain.pem ${shellQuote(dest)}/privkey.pem`,
  ].join("\n");
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`failed to sync TLS certs for mosquitto: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {ReturnType<typeof resolveStepCaSettings>} stepCa
 */
export function ensureStepCaRootOnGuest(exec, stepCa) {
  const cmd = [
    "set -euo pipefail",
    `curl -fsSk -o ${shellQuote(stepCa.rootCaPath)} ${shellQuote(stepCa.rootUrl)}`,
    `chmod 644 ${shellQuote(stepCa.rootCaPath)}`,
  ].join("\n");
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`failed to install step-ca root: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} certName
 */
export function certExistsOnGuest(exec, certName) {
  const safe = String(certName).replace(/[^a-zA-Z0-9._-]/g, "");
  const r = exec.run(`test -f /etc/letsencrypt/live/${safe}/fullchain.pem`, { capture: true });
  return r.status === 0;
}

/**
 * @param {object} opts
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.exec
 * @param {Record<string, unknown>} opts.mosquitto
 * @param {boolean} [opts.forceRenew]
 */
export function obtainOrRenewCertOnGuest(opts) {
  const { exec, mosquitto, forceRenew = false } = opts;
  if (!tlsEnabled(mosquitto)) {
    return { ok: true, skipped: true, message: "TLS disabled" };
  }
  if (tlsCertSource(mosquitto) === "nginx-waf") {
    return ensureTlsFromNginxWaf({ exec, mosquitto });
  }
  const certName = tlsCertName(mosquitto);
  const stepCa = resolveStepCaSettings(mosquitto);
  const email = resolveAcmeEmail(mosquitto);
  ensureStepCaRootOnGuest(exec, stepCa);

  if (!forceRenew && certExistsOnGuest(exec, certName)) {
    errout.write(`[hdc] mosquitto tls: certificate ${certName} already present — skipping obtain\n`);
    syncTlsCertsForMosquitto(exec, mosquitto);
    installCertRenewTimer(exec, mosquitto);
    return { ok: true, skipped: true, message: "cert already present" };
  }

  const caBundle = `REQUESTS_CA_BUNDLE=${shellQuote(stepCa.rootCaPath)} `;
  const obtainCmd = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "systemctl stop mosquitto 2>/dev/null || true",
    `${caBundle}certbot certonly -n --standalone --preferred-challenges http --agree-tos`,
    `--email ${shellQuote(email)}`,
    `--server ${shellQuote(stepCa.acmeServer)}`,
    `-d ${shellQuote(certName)}`,
    `--cert-name ${shellQuote(certName)}`,
  ].join(" ");

  const r = exec.run(obtainCmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}\n${r.stdout}`.trim();
    throw new Error(`certbot obtain failed: ${detail || `exit ${r.status}`}`);
  }

  installCertRenewTimer(exec, mosquitto);
  syncTlsCertsForMosquitto(exec, mosquitto);
  return { ok: true, cert_name: certName, message: "certificate obtained" };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} mosquitto
 */
export function renewCertsOnGuest(exec, mosquitto) {
  if (tlsCertSource(mosquitto) === "nginx-waf") {
    return ensureTlsFromNginxWaf({ exec, mosquitto });
  }
  const certName = tlsCertName(mosquitto).replace(/[^a-zA-Z0-9._-]/g, "");
  const dest = tlsCertDir(mosquitto);
  const hook = [
    `cp -L /etc/letsencrypt/live/${certName}/fullchain.pem ${dest}/fullchain.pem`,
    `cp -L /etc/letsencrypt/live/${certName}/privkey.pem ${dest}/privkey.pem`,
    `chown mosquitto:mosquitto ${dest}/fullchain.pem ${dest}/privkey.pem`,
    "systemctl reload mosquitto || systemctl restart mosquitto",
  ].join(" && ");
  const r = exec.run(`certbot renew --non-interactive --deploy-hook ${shellQuote(hook)}`, {
    capture: true,
  });
  if (r.status !== 0) {
    const detail = `${r.stderr}\n${r.stdout}`.trim();
    throw new Error(`certbot renew failed: ${detail || `exit ${r.status}`}`);
  }
  return { ok: true, message: "certbot renew finished" };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} mosquitto
 */
export function installCertRenewTimer(exec, mosquitto) {
  const certName = tlsCertName(mosquitto).replace(/[^a-zA-Z0-9._-]/g, "");
  const dest = tlsCertDir(mosquitto);
  const hook = [
    `cp -L /etc/letsencrypt/live/${certName}/fullchain.pem ${dest}/fullchain.pem`,
    `cp -L /etc/letsencrypt/live/${certName}/privkey.pem ${dest}/privkey.pem`,
    `chown mosquitto:mosquitto ${dest}/fullchain.pem ${dest}/privkey.pem`,
    "systemctl reload mosquitto || systemctl restart mosquitto",
  ].join(" && ");
  const unit = `[Unit]
Description=Renew Mosquitto TLS certificates (step-ca ACME)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --non-interactive --deploy-hook ${shellQuote(hook)}

[Install]
WantedBy=multi-user.target
`;
  const timer = `[Unit]
Description=Twice-daily Mosquitto cert renewal

[Timer]
OnBootSec=5min
OnUnitActiveSec=12h
Persistent=true

[Install]
WantedBy=timers.target
`;
  const b64Unit = Buffer.from(unit, "utf8").toString("base64");
  const b64Timer = Buffer.from(timer, "utf8").toString("base64");
  const cmd = [
    "set -euo pipefail",
    `echo ${shellQuote(b64Unit)} | base64 -d > /etc/systemd/system/hdc-mosquitto-cert-renew.service`,
    `echo ${shellQuote(b64Timer)} | base64 -d > /etc/systemd/system/hdc-mosquitto-cert-renew.timer`,
    "systemctl daemon-reload",
    "systemctl enable --now hdc-mosquitto-cert-renew.timer",
  ].join("\n");
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`cert renew timer install failed: ${r.stderr || r.stdout}`);
  }
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function createMosquittoExec(user, pveHost, vmid) {
  return createConfigureExec("pct", {
    user,
    host: pveHost,
    vmid,
    pveHost,
  });
}

/**
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 */
export function ensureCertbotPackages(user, pveHost, vmid) {
  const script = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "printf 'nameserver 192.0.2.2\\nnameserver 192.0.2.3\\n' > /etc/resolv.conf",
    "apt-get update -qq",
    "apt-get install -y -qq mosquitto mosquitto-clients certbot ca-certificates curl",
  ].join("\n");
  const r = pctExec(user, pveHost, vmid, script);
  if (r.status !== 0) {
    throw new Error(`apt install failed (exit ${r.status})`);
  }
}
