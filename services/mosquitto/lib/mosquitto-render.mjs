/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const HDC_CONF_PATH = "/etc/mosquitto/conf.d/hdc.conf";
export const HDC_ACL_PATH = "/etc/mosquitto/conf.d/hdc-acl";
export const HDC_PASSWD_PATH = "/etc/mosquitto/conf.d/hdc-passwd";
export const MOSQUITTO_CERT_DIR = "/etc/mosquitto/certs";

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function tlsBlock(mosquitto) {
  const tls = isObject(mosquitto.tls) ? mosquitto.tls : {};
  return tls;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function tlsEnabled(mosquitto) {
  const tls = tlsBlock(mosquitto);
  return tls.enabled !== false;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function tlsCertName(mosquitto) {
  const tls = tlsBlock(mosquitto);
  const v = typeof tls.cert_name === "string" ? tls.cert_name.trim() : "";
  if (!v) throw new Error("mosquitto.tls.cert_name required when TLS is enabled");
  return v;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function tlsListenerPort(mosquitto) {
  const tls = tlsBlock(mosquitto);
  const p = typeof tls.listener_port === "number" ? tls.listener_port : Number(tls.listener_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8883;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function tlsCertDir(mosquitto) {
  const tls = tlsBlock(mosquitto);
  const explicit = typeof tls.cert_dir === "string" ? tls.cert_dir.trim() : "";
  if (explicit) return explicit;
  return MOSQUITTO_CERT_DIR;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function tlsRootCaPath(mosquitto) {
  const tls = tlsBlock(mosquitto);
  const v = typeof tls.root_ca_path === "string" ? tls.root_ca_path.trim() : "";
  return v || "/etc/ssl/certs/hdc-step-ca-root.crt";
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function plainListenerEnabled(mosquitto) {
  const plain = isObject(mosquitto.plain_listener) ? mosquitto.plain_listener : {};
  return plain.enabled === true;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function plainListenerPort(mosquitto) {
  const plain = isObject(mosquitto.plain_listener) ? mosquitto.plain_listener : {};
  const p = typeof plain.port === "number" ? plain.port : Number(plain.port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 1883;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function normalizeUsers(mosquitto) {
  const users = Array.isArray(mosquitto.users) ? mosquitto.users : [];
  return users
    .filter(isObject)
    .map((entry, idx) => {
      const username =
        typeof entry.username === "string" && entry.username.trim()
          ? entry.username.trim()
          : `user-${idx + 1}`;
      const passwordVaultKey =
        typeof entry.password_vault_key === "string" && entry.password_vault_key.trim()
          ? entry.password_vault_key.trim()
          : "";
      return { username, password_vault_key: passwordVaultKey };
    });
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function normalizeAcl(mosquitto) {
  const acl = Array.isArray(mosquitto.acl) ? mosquitto.acl : [];
  return acl
    .filter(isObject)
    .map((entry) => {
      const user = typeof entry.user === "string" ? entry.user.trim() : "";
      const topic = typeof entry.topic === "string" ? entry.topic.trim() : "";
      const access =
        typeof entry.access === "string" && entry.access.trim()
          ? entry.access.trim().toLowerCase()
          : "readwrite";
      return { user, topic, access };
    })
    .filter((e) => e.user && e.topic);
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function renderAclFile(mosquitto) {
  const lines = ["# hdc-generated"];
  /** @type {string | null} */
  let currentUser = null;
  for (const rule of normalizeAcl(mosquitto)) {
    if (rule.user !== currentUser) {
      lines.push(`user ${rule.user}`);
      currentUser = rule.user;
    }
    lines.push(`topic ${rule.access} ${rule.topic}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} mosquitto
 */
export function renderMosquittoConf(mosquitto) {
  const lines = [
    "# hdc-generated",
    "allow_anonymous false",
    `password_file ${HDC_PASSWD_PATH}`,
    `acl_file ${HDC_ACL_PATH}`,
    "log_dest syslog",
  ];

  if (plainListenerEnabled(mosquitto)) {
    lines.push("", `listener ${plainListenerPort(mosquitto)}`, "protocol mqtt");
  }

  if (tlsEnabled(mosquitto)) {
    const certDir = tlsCertDir(mosquitto);
    lines.push(
      "",
      `listener ${tlsListenerPort(mosquitto)}`,
      "protocol mqtt",
      `certfile ${certDir}/fullchain.pem`,
      `keyfile ${certDir}/privkey.pem`,
      `cafile ${tlsRootCaPath(mosquitto)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Build shell snippet to recreate password file (passwords passed as env vars in caller script).
 * @param {{ username: string; envVar: string }[]} userEnvVars
 */
export function renderPasswdScript(userEnvVars) {
  const lines = [
    "set -euo pipefail",
    "install -m 0750 -d /etc/mosquitto/conf.d",
    "chown root:mosquitto /etc/mosquitto/conf.d",
    "chmod 750 /etc/mosquitto/conf.d",
    `rm -f ${HDC_PASSWD_PATH}`,
    "touch " + HDC_PASSWD_PATH,
    "chmod 640 " + HDC_PASSWD_PATH,
  ];
  for (const { username, envVar } of userEnvVars) {
    const safeUser = username.replace(/'/g, `'\\''`);
    lines.push(`mosquitto_passwd -b ${HDC_PASSWD_PATH} '${safeUser}' "$${envVar}"`);
  }
  lines.push(`chown mosquitto:mosquitto ${HDC_PASSWD_PATH}`, `chmod 640 ${HDC_PASSWD_PATH}`);
  return lines.join("\n");
}
