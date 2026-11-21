/**
 * nginx-waf certificate HA: every WAF node in a deployment group can renew, and nodes keep each
 * other's /etc/letsencrypt lineages in sync. The on-host tool (assets/hdc-nginx-waf-certs.py) does the
 * work; this module renders its config + systemd units and installs everything over the configure exec,
 * so nodes are rebuilt (or new waf-c/waf-d added) purely from hdc config.
 *
 * Config (deployment_groups[].acme.cert_ha):
 *   enabled                bool (default false)
 *   priority               [system_id, ...] renew leader order (default: cert-primary first, then config order)
 *   peer_ssh_public_key    "ssh-ed25519 AAAA… hdc-nginx-waf-certs" (shared node-to-node key, public half)
 *   peer_ssh_key_vault_key vault key holding the private half (default HDC_NGINX_WAF_CERT_PEER_SSH_KEY)
 *   trust_root_ca_files    repo-relative PEM files added to the system trust store (e.g. step-ca root)
 *   warn_days / takeover_days / takeover_after_hours
 *   alert: { mail_to: [..], mail_from, uptime_kuma_push_url }
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRepoFile } from "hdc/cli/lib/private-repo.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { sshTargetFromDeployment } from "./deployments.mjs";
import { ensureAllAcmeDnsCredentials } from "./letsencrypt.mjs";
import { CERT_SYNC_HOOK_PATH, CERT_SYNC_SCRIPT_PATH } from "./cert-sync.mjs";

const libDir = dirname(fileURLToPath(import.meta.url));
export const CERT_HA_TOOL_ASSET = join(libDir, "..", "assets", "hdc-nginx-waf-certs.py");

export const CERT_HA_TOOL_PATH = "/usr/local/sbin/hdc-nginx-waf-certs";
export const CERT_HA_CONFIG_PATH = "/etc/hdc/nginx-waf-certs.json";
export const CERT_HA_KEY_DIR = "/etc/hdc/nginx-waf-certs";
export const CERT_HA_KEY_PATH = `${CERT_HA_KEY_DIR}/id_ed25519`;
export const CERT_HA_STATE_DIR = "/var/lib/hdc-nginx-waf-certs";
export const CERT_HA_HOOK_PATH = "/etc/letsencrypt/renewal-hooks/deploy/hdc-nginx-waf-certs";
export const CERT_HA_SUDOERS_PATH = "/etc/sudoers.d/hdc-nginx-waf-certs";
export const CERT_HA_TRUST_DIR = "/usr/local/share/ca-certificates";
export const CERT_HA_KEY_COMMENT = "hdc-nginx-waf-certs";
export const DEFAULT_PEER_KEY_VAULT_KEY = "HDC_NGINX_WAF_CERT_PEER_SSH_KEY";
export const RENEW_UNIT = "hdc-nginx-waf-cert-renew";
export const CHECK_UNIT = "hdc-nginx-waf-cert-check";
export const ACME_HTTP01_WEBROOT = "/var/www/letsencrypt/.well-known/acme-challenge";
export const ACME_HTTP01_AUTH_HOOK_PATH = "/etc/letsencrypt/hdc-acme-auth-hook.sh";
export const ACME_HTTP01_CLEANUP_HOOK_PATH = "/etc/letsencrypt/hdc-acme-cleanup-hook.sh";

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {unknown} acmeRaw deployment group acme block (raw config)
 */
export function parseCertHaSettings(acmeRaw) {
  const raw = isObject(acmeRaw) && isObject(acmeRaw.cert_ha) ? acmeRaw.cert_ha : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const alert = isObject(raw.alert) ? raw.alert : {};
  const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    enabled: raw.enabled === true,
    priority: strList(raw.priority),
    peerPublicKey: typeof raw.peer_ssh_public_key === "string" ? raw.peer_ssh_public_key.trim() : "",
    peerKeyVaultKey:
      typeof raw.peer_ssh_key_vault_key === "string" && raw.peer_ssh_key_vault_key.trim()
        ? raw.peer_ssh_key_vault_key.trim()
        : DEFAULT_PEER_KEY_VAULT_KEY,
    trustRootCaFiles: strList(raw.trust_root_ca_files),
    warnDays: num(raw.warn_days, 14),
    takeoverDays: num(raw.takeover_days, 21),
    takeoverAfterHours: num(raw.takeover_after_hours, 36),
    alert: {
      mailTo: strList(alert.mail_to),
      mailFrom: typeof alert.mail_from === "string" ? alert.mail_from.trim() : "",
      uptimeKumaPushUrl: typeof alert.uptime_kuma_push_url === "string" ? alert.uptime_kuma_push_url.trim() : "",
    },
    distribute: parseCertHaDistribute(raw.distribute),
  };
}

/**
 * Extra cert-copy targets (e.g. mosquitto). Uses the existing peer SSH key; no new credential.
 * @param {unknown} raw
 * @returns {{ id: string, host: string, user: string, certNames: string[] }[]}
 */
export function parseCertHaDistribute(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {{ id: string, host: string, user: string, certNames: string[] }[]} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (item);
    const host = typeof rec.host === "string" ? rec.host.trim() : "";
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : host;
    const user = typeof rec.user === "string" && rec.user.trim() ? rec.user.trim() : "root";
    const certNames = Array.isArray(rec.cert_names)
      ? rec.cert_names.map((n) => String(n).trim()).filter(Boolean)
      : [];
    if (!host || !/^[A-Za-z0-9.\-]+$/.test(host)) continue;
    if (!id || !certNames.length) continue;
    out.push({ id, host, user, certNames });
  }
  return out;
}

/**
 * LAN address of a deployment (proxmox.qemu.ip, else configure.ssh.host).
 * @param {Record<string, any>} deployment
 */
export function deploymentLanHost(deployment) {
  const prox = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const qemu = isObject(prox.qemu) ? prox.qemu : {};
  const ip = typeof qemu.ip === "string" && qemu.ip.trim() ? qemu.ip.trim().split("/")[0] : "";
  return ip || sshTargetFromDeployment(deployment).host;
}

/**
 * Ordered node list (priority 0 = renew leader).
 * @param {Record<string, any>[]} groupDeployments ALL deployments in the group (not --instance filtered)
 * @param {ReturnType<typeof parseCertHaSettings>} settings
 * @param {string} [certPrimarySystemId]
 */
export function certHaNodes(groupDeployments, settings, certPrimarySystemId = "") {
  const byId = new Map(groupDeployments.map((d) => [d.systemId, d]));
  /** @type {string[]} */
  const order = [];
  for (const id of settings.priority) {
    if (!byId.has(id)) throw new Error(`cert_ha.priority: unknown system_id ${JSON.stringify(id)}`);
    if (!order.includes(id)) order.push(id);
  }
  const rest = groupDeployments
    .map((d) => d.systemId)
    .filter((id) => !order.includes(id))
    .sort((a, b) => {
      const pa = a === certPrimarySystemId || byId.get(a)?.role === "cert-primary" ? 0 : 1;
      const pb = b === certPrimarySystemId || byId.get(b)?.role === "cert-primary" ? 0 : 1;
      return pa - pb || a.localeCompare(b);
    });
  order.push(...rest);
  return order.map((id, priority) => {
    const d = byId.get(id);
    const ssh = sshTargetFromDeployment(d);
    return { id, host: deploymentLanHost(d), user: ssh.user, priority };
  });
}

/**
 * @param {string} selfId
 * @param {ReturnType<typeof certHaNodes>} nodes
 * @param {ReturnType<typeof parseCertHaSettings>} settings
 */
export function renderCertHaConfig(selfId, nodes, settings) {
  const cfg = {
    "//": "Managed by hdc nginx-waf (cert-ha.mjs) — do not edit on the host",
    self: selfId,
    nodes,
    ssh_key: CERT_HA_KEY_PATH,
    warn_days: settings.warnDays,
    takeover_days: settings.takeoverDays,
    takeover_after_hours: settings.takeoverAfterHours,
    alert: {
      mail_to: settings.alert.mailTo,
      mail_from: settings.alert.mailFrom,
      uptime_kuma_push_url: settings.alert.uptimeKumaPushUrl,
    },
    distribute: (settings.distribute || []).map((d) => ({
      id: d.id,
      host: d.host,
      user: d.user,
      cert_names: d.certNames,
    })),
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/**
 * systemd units; timers staggered by priority so the leader always runs first (host clocks are UTC).
 * @param {number} priority
 */
export function renderCertHaUnits(priority) {
  const minute = (10 + 20 * priority) % 60;
  const hourShift = Math.floor((10 + 20 * priority) / 60);
  const mm = String(minute).padStart(2, "0");
  const renewHours = [3 + hourShift, 15 + hourShift].map((h) => String(h % 24).padStart(2, "0")).join(",");
  const checkHour = String((6 + hourShift) % 24).padStart(2, "0");
  const head = "# Managed by hdc nginx-waf (cert-ha.mjs) — do not edit on the host";
  return {
    [`${RENEW_UNIT}.service`]: `${head}
[Unit]
Description=hdc nginx-waf leader-aware certificate renewal
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${CERT_HA_TOOL_PATH} renew
`,
    [`${RENEW_UNIT}.timer`]: `${head}
[Unit]
Description=hdc nginx-waf certificate renewal (priority ${priority})

[Timer]
OnCalendar=*-*-* ${renewHours}:${mm}:00
Persistent=true

[Install]
WantedBy=timers.target
`,
    [`${CHECK_UNIT}.service`]: `${head}
[Unit]
Description=hdc nginx-waf daily certificate check / peer sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${CERT_HA_TOOL_PATH} check --quiet
`,
    [`${CHECK_UNIT}.timer`]: `${head}
[Unit]
Description=hdc nginx-waf daily certificate check (priority ${priority})

[Timer]
OnCalendar=*-*-* ${checkHour}:${mm}:00
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

/**
 * authorized_keys line restricting the shared peer key to the cert tool, from peer addresses only.
 * @param {string} publicKey
 * @param {string[]} fromHosts
 */
export function renderPeerAuthorizedKey(publicKey, fromHosts) {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !/^ssh-(ed25519|rsa)$|^ecdsa-/.test(parts[0])) {
    throw new Error("cert_ha.peer_ssh_public_key must be an OpenSSH public key");
  }
  for (const h of fromHosts) {
    if (!/^[A-Za-z0-9.\-:*]+$/.test(h)) throw new Error(`bad peer host ${JSON.stringify(h)}`);
  }
  const opts = [
    `command="${CERT_HA_TOOL_PATH} serve"`,
    "no-pty",
    "no-port-forwarding",
    "no-agent-forwarding",
    "no-X11-forwarding",
    fromHosts.length ? `from="${fromHosts.join(",")}"` : "",
  ].filter(Boolean);
  return `${opts.join(",")} ${parts[0]} ${parts[1]} ${CERT_HA_KEY_COMMENT}`;
}

function runChecked(exec, cmd, log, label) {
  log.info(`${exec.label}: ${label ?? cmd.split("\n")[0].slice(0, 120)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(label ? `${label}: ${detail.slice(0, 400)}` : detail);
  }
  return r;
}

/** Max base64 chars per remote command (Windows CreateProcess caps a command line at 32767 chars). */
const UPLOAD_CHUNK = 8000;

/** Upload content atomically (chunked for large files); never echoes content into logs. */
function uploadFile(exec, remotePath, content, log, mode = "644") {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const tmp = `${remotePath}.hdc-tmp`;
  const tmpB64 = `${tmp}.b64`;
  const label = `write ${remotePath} (${mode})`;
  if (b64.length <= UPLOAD_CHUNK) {
    runChecked(
      exec,
      `umask 077 && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(tmp)} && chmod ${mode} ${shellQuote(tmp)} && mv -f ${shellQuote(tmp)} ${shellQuote(remotePath)}`,
      log,
      label,
    );
    return;
  }
  runChecked(exec, `umask 077 && : > ${shellQuote(tmpB64)}`, log, `${label} [start]`);
  for (let i = 0; i < b64.length; i += UPLOAD_CHUNK) {
    const part = b64.slice(i, i + UPLOAD_CHUNK);
    const r = exec.run(`printf %s ${shellQuote(part)} >> ${shellQuote(tmpB64)}`, { capture: true });
    if (r.status !== 0) throw new Error(`${label}: chunk ${i / UPLOAD_CHUNK} failed: ${`${r.stderr}${r.stdout}`.trim().slice(0, 300)}`);
  }
  runChecked(
    exec,
    `umask 077 && base64 -d ${shellQuote(tmpB64)} > ${shellQuote(tmp)} && rm -f ${shellQuote(tmpB64)} && chmod ${mode} ${shellQuote(tmp)} && mv -f ${shellQuote(tmp)} ${shellQuote(remotePath)}`,
    log,
    `${label} [${Math.ceil(b64.length / UPLOAD_CHUNK)} chunks]`,
  );
}


/**
 * Validate peer host tokens used in generated hook / ssh-keyscan scripts.
 * @param {string[]} hosts
 * @returns {string[]}
 */
export function assertSafePeerHosts(hosts) {
  const out = [];
  for (const raw of hosts || []) {
    const h = String(raw || "").trim();
    if (!h) continue;
    if (!/^[A-Za-z0-9.-]+$/.test(h)) throw new Error(`bad peer host ${JSON.stringify(h)}`);
    out.push(h);
  }
  return out;
}

/**
 * HTTP-01 auth hook used by manual+http-01 lineages (e.g. vault.dukk.org behind Cloudflare).
 * Writes the token on this node and copies it to every other WAF so either origin can answer.
 * @param {string[]} peerHosts
 */
export function renderAcmeHttp01AuthHook(peerHosts) {
  const peers = assertSafePeerHosts(peerHosts);
  const peerList = peers.map((h) => shellQuote(h)).join(" ");
  const peerLoop = peers.length
    ? `for peer in ${peerList}; do
  sudo -u "$HOOK_USER" ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOOK_USER@$peer" "sudo mkdir -p $WEBROOT && echo -n \"$CERTBOT_VALIDATION\" | sudo tee $WEBROOT/\"$CERTBOT_TOKEN\" > /dev/null && sudo chmod 644 $WEBROOT/\"$CERTBOT_TOKEN\""
done`
    : ": # no peer WAFs";
  return `#!/bin/bash
# Managed by hdc nginx-waf (cert-ha.mjs) — do not edit on the host
set -euo pipefail
HOOK_USER=hdc
WEBROOT=${ACME_HTTP01_WEBROOT}
mkdir -p "$WEBROOT"
echo -n "$CERTBOT_VALIDATION" > "$WEBROOT/$CERTBOT_TOKEN"
chmod 644 "$WEBROOT/$CERTBOT_TOKEN"
${peerLoop}
`;
}

/**
 * @param {string[]} peerHosts
 */
export function renderAcmeHttp01CleanupHook(peerHosts) {
  const peers = assertSafePeerHosts(peerHosts);
  const peerList = peers.map((h) => shellQuote(h)).join(" ");
  const peerLoop = peers.length
    ? `for peer in ${peerList}; do
  sudo -u "$HOOK_USER" ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOOK_USER@$peer" "sudo rm -f $WEBROOT/\"$CERTBOT_TOKEN\""
done`
    : ": # no peer WAFs";
  return `#!/bin/bash
# Managed by hdc nginx-waf (cert-ha.mjs) — do not edit on the host
set -euo pipefail
HOOK_USER=hdc
WEBROOT=${ACME_HTTP01_WEBROOT}
rm -f "$WEBROOT/$CERTBOT_TOKEN"
${peerLoop}
`;
}

/**
 * Ensure the automation user can BatchMode SSH to every other WAF (host keys only; no new credentials).
 * @param {{ label: string; run: Function }} exec
 * @param {{ info: Function }} log
 * @param {string} user
 * @param {string[]} peerHosts
 */
function ensurePeerKnownHosts(exec, log, user, peerHosts) {
  const peers = assertSafePeerHosts(peerHosts);
  if (!peers.length) return;
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error(`bad ssh user ${JSON.stringify(user)}`);
  const hosts = peers.map((h) => shellQuote(h)).join(" ");
  runChecked(
    exec,
    [
      "set -euo pipefail",
      `U=${shellQuote(user)}`,
      'H=$(getent passwd "$U" | cut -d: -f6)',
      'test -n "$H"',
      'install -d -m 700 -o "$U" -g "$U" "$H/.ssh"',
      'F="$H/.ssh/known_hosts"',
      'touch "$F" && chown "$U:$U" "$F" && chmod 600 "$F"',
      `for host in ${hosts}; do`,
      '  ssh-keygen -R "$host" -f "$F" >/dev/null 2>&1 || true',
      '  ssh-keyscan -T 5 "$host" >> "$F"',
      "done",
      'chown "$U:$U" "$F" && chmod 600 "$F"',
    ].join("\n"),
    log,
    `known_hosts for ${user} (peers ${peers.join(",")})`,
  );
}

/**
 * Install/refresh cert HA on one node. Idempotent.
 * @param {object} opts
 * @param {{ label: string; run: Function }} opts.exec
 * @param {{ info: Function }} opts.log
 * @param {Record<string, any>} opts.deployment
 * @param {ReturnType<typeof certHaNodes>} opts.nodes
 * @param {ReturnType<typeof parseCertHaSettings>} opts.settings
 * @param {string} opts.peerPrivateKey OpenSSH private key (from vault)
 * @param {{ name: string; pem: string }[]} opts.trustRoots
 */
export function installCertHaOnNode(opts) {
  const { exec, log, deployment, nodes, settings, peerPrivateKey, trustRoots, global, tsigSecret } = opts;
  const self = nodes.find((n) => n.id === deployment.systemId);
  if (!self) throw new Error(`${deployment.systemId} is not in the cert HA node list`);
  if (!settings.peerPublicKey) throw new Error("cert_ha.peer_ssh_public_key is required");
  if (!peerPrivateKey || !peerPrivateKey.includes("PRIVATE KEY")) {
    throw new Error(`vault ${settings.peerKeyVaultKey} does not hold an OpenSSH private key`);
  }
  const user = self.user;
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error(`bad ssh user ${JSON.stringify(user)}`);

  runChecked(
    exec,
    `command -v python3 >/dev/null && command -v openssl >/dev/null && command -v ssh >/dev/null || apt-get install -y python3 openssl openssh-client`,
    log,
  );
  runChecked(
    exec,
    "dpkg -s python3-certbot-dns-rfc2136 >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y python3-certbot-dns-rfc2136",
    log,
  );
  runChecked(
    exec,
    `install -d -m 755 /etc/hdc && install -d -m 700 ${CERT_HA_KEY_DIR} ${CERT_HA_STATE_DIR} && install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy`,
    log,
  );

  // 1. trust roots (e.g. internal step-ca) in the system store so `certbot renew` trusts the ACME server
  for (const root of trustRoots) {
    if (!/^[A-Za-z0-9._-]+\.crt$/.test(root.name)) throw new Error(`bad trust root name ${root.name}`);
    uploadFile(exec, `${CERT_HA_TRUST_DIR}/${root.name}`, `${root.pem.trim()}\n`, log, "644");
  }
  if (trustRoots.length) runChecked(exec, "update-ca-certificates >/dev/null", log);

  // 1b. DNS-01 (RFC2136/TSIG) credentials on every node, one file per zone, so any node can renew
  if (global && tsigSecret && global.dnsZone && global.dnsNameservers?.length) {
    ensureAllAcmeDnsCredentials({ exec, log, global, tsigSecret });
  }

  // 2. tool, config, key
  const tool = readFileSync(CERT_HA_TOOL_ASSET, "utf8");
  uploadFile(exec, CERT_HA_TOOL_PATH, tool, log, "755");
  uploadFile(exec, CERT_HA_CONFIG_PATH, renderCertHaConfig(self.id, nodes, settings), log, "644");
  uploadFile(exec, CERT_HA_KEY_PATH, `${peerPrivateKey.replace(/\r\n?/g, "\n").trim()}\n`, log, "600");

  // 3. sudo rule for the forced command (validated before install)
  const sudoers = `# Managed by hdc nginx-waf (cert-ha.mjs)\n${user} ALL=(root) NOPASSWD: ${CERT_HA_TOOL_PATH} serve-root *\n`;
  uploadFile(exec, `${CERT_HA_SUDOERS_PATH}.hdc-new`, sudoers, log, "440");
  runChecked(
    exec,
    `visudo -cf ${shellQuote(`${CERT_HA_SUDOERS_PATH}.hdc-new`)} >/dev/null && mv -f ${shellQuote(`${CERT_HA_SUDOERS_PATH}.hdc-new`)} ${shellQuote(CERT_HA_SUDOERS_PATH)}`,
    log,
  );

  // 4. authorized_keys: replace only the managed line (identified by comment), keep every other key
  const peerHosts = nodes.filter((n) => n.id !== self.id).map((n) => n.host);
  const line = renderPeerAuthorizedKey(settings.peerPublicKey, peerHosts);
  const ak = [
    "set -e",
    `U=${shellQuote(user)}`,
    'H=$(getent passwd "$U" | cut -d: -f6)',
    'test -n "$H"',
    'install -d -m 700 -o "$U" -g "$U" "$H/.ssh"',
    'F="$H/.ssh/authorized_keys"',
    'touch "$F"',
    `BEFORE=$(grep -vc ' ${CERT_HA_KEY_COMMENT}$' "$F" || true)`,
    `{ grep -v ' ${CERT_HA_KEY_COMMENT}$' "$F" || true; printf '%s\\n' ${shellQuote(line)}; } > "$F.hdc-new"`,
    `AFTER=$(grep -vc ' ${CERT_HA_KEY_COMMENT}$' "$F.hdc-new" || true)`,
    'test "$BEFORE" = "$AFTER"',
    'chown "$U:$U" "$F.hdc-new" && chmod 600 "$F.hdc-new" && mv -f "$F.hdc-new" "$F"',
  ].join("\n");
  runChecked(exec, ak, log, `authorized_keys managed peer line for ${user} (from ${peerHosts.join(",") || "-"})`);

  // 4b. HTTP-01 manual hooks + hdc known_hosts so any WAF can renew CF-proxied names (e.g. vault.dukk.org)
  ensurePeerKnownHosts(exec, log, user, peerHosts);
  uploadFile(exec, ACME_HTTP01_AUTH_HOOK_PATH, renderAcmeHttp01AuthHook(peerHosts), log, "755");
  uploadFile(exec, ACME_HTTP01_CLEANUP_HOOK_PATH, renderAcmeHttp01CleanupHook(peerHosts), log, "755");

  // 5. certbot deploy hook → tool; retire the old single-peer sync hook/script
  uploadFile(
    exec,
    CERT_HA_HOOK_PATH,
    `#!/bin/sh\n# Managed by hdc nginx-waf (cert-ha.mjs)\nexec ${CERT_HA_TOOL_PATH} deploy-hook\n`,
    log,
    "755",
  );
  runChecked(exec, `rm -f ${shellQuote(CERT_SYNC_HOOK_PATH)} ${shellQuote(CERT_SYNC_SCRIPT_PATH)}`, log);

  // 6. systemd: our timers replace certbot.timer (which would renew on every node without a lock)
  const units = renderCertHaUnits(self.priority);
  for (const [name, body] of Object.entries(units)) {
    uploadFile(exec, `/etc/systemd/system/${name}`, body, log, "644");
  }
  runChecked(
    exec,
    [
      "systemctl daemon-reload",
      `systemctl enable --now ${RENEW_UNIT}.timer ${CHECK_UNIT}.timer`,
      "systemctl disable --now certbot.timer 2>/dev/null || true",
      "systemctl mask certbot.timer 2>/dev/null || true",
    ].join(" && "),
    log,
  );
  log.info(`${self.id}: cert HA installed (priority ${self.priority}, peers: ${peerHosts.join(", ") || "none"})`);
  return { system_id: self.id, priority: self.priority, peers: peerHosts };
}

/**
 * Run the tool on a node (e.g. `push --all`, `check`, `status`).
 * @param {{ label: string; run: Function }} exec
 * @param {string} args
 * @param {{ info: Function }} log
 */
export function runCertHaTool(exec, args, log) {
  if (!/^[A-Za-z0-9 ._,-]+$/.test(args)) throw new Error(`bad cert HA args ${JSON.stringify(args)}`);
  return runChecked(exec, `${CERT_HA_TOOL_PATH} ${args}`, log);
}

/**
 * @param {{ run: Function }} exec
 */
export function certHaInstalled(exec) {
  return exec.run(`test -x ${CERT_HA_TOOL_PATH} && test -s ${CERT_HA_CONFIG_PATH}`, { capture: true }).status === 0;
}

/**
 * Read trust root PEMs (repo-relative; public hdc first, then hdc-private).
 * @param {ReturnType<typeof parseCertHaSettings>} settings
 */
export function loadCertHaTrustRoots(settings) {
  return settings.trustRootCaFiles.map((rel) => {
    const r = resolveRepoFile(repoRoot(), rel.replace(/\\/g, "/"));
    if (!(r.found ?? r.exists)) throw new Error(`cert_ha.trust_root_ca_files: not found: ${rel}`);
    const pem = readFileSync(r.path, "utf8");
    if (!pem.includes("BEGIN CERTIFICATE")) throw new Error(`${rel} is not a PEM certificate`);
    const base = rel.split("/").pop() || "hdc-root.crt";
    return { name: base.endsWith(".crt") ? base : `${base}.crt`, pem };
  });
}

/**
 * Resolve cert HA for a deployment group (null when disabled).
 * @param {object} opts
 * @param {unknown} opts.acmeRaw
 * @param {Record<string, any>[]} opts.groupDeployments ALL deployments of the group
 * @param {string} opts.certPrimarySystemId
 * @param {{ getSecret: Function }} opts.vault unlocked vault access
 */
export async function prepareCertHa(opts) {
  const settings = parseCertHaSettings(opts.acmeRaw);
  if (!settings.enabled) return null;
  const nodes = certHaNodes(opts.groupDeployments, settings, opts.certPrimarySystemId);
  const peerPrivateKey = String(
    await opts.vault.getSecret(settings.peerKeyVaultKey, { promptLabel: `vault secret ${settings.peerKeyVaultKey}` }),
  );
  return { settings, nodes, peerPrivateKey, trustRoots: loadCertHaTrustRoots(settings) };
}

/**
 * ACME HTTP-01 vhost options for a node: peers fallback under cert HA, else legacy proxy-to-primary.
 * @param {Awaited<ReturnType<typeof prepareCertHa>> | null} ha
 * @param {Record<string, any>} deployment
 * @param {string} legacyProxy
 */
export function acmeVhostOptions(ha, deployment, legacyProxy) {
  if (ha) {
    return { acmePeers: ha.nodes.filter((n) => n.id !== deployment.systemId).map((n) => n.host) };
  }
  return { acmeChallengeProxy: legacyProxy };
}
