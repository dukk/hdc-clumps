import { readFileSync } from "node:fs";
import { env, stderr as errout } from "node:process";

import { resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { tlsCertName, tlsCertDir, tlsEnabled, tlsRootCaPath } from "./mosquitto-render.mjs";

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
