import {
  loadMailRelayAppSettings,
  resolveMailRecipients,
} from "hdc/package/mail-relay-settings.mjs";
import { mailBlockFromService } from "hdc/package/app-mail-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} gitlab
 */
export function normalizeExternalUrl(gitlab) {
  const d = typeof gitlab.external_url === "string" ? gitlab.external_url.trim() : "";
  if (!d) {
    throw new Error("gitlab.external_url is required (https://… for nginx-waf)");
  }
  if (!/^https:\/\//i.test(d)) {
    throw new Error("gitlab.external_url must start with https://");
  }
  return d.replace(/\/+$/, "");
}

/**
 * @param {Record<string, unknown>} gitlab
 */
export function normalizeImageTag(gitlab) {
  const t = typeof gitlab.image_tag === "string" ? gitlab.image_tag.trim() : "";
  if (!t) return "latest";
  return t;
}

/**
 * @param {Record<string, unknown>} gitlab
 */
export function hostPort(gitlab) {
  const p = typeof gitlab.host_port === "number" ? gitlab.host_port : Number(gitlab.host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 80;
}

/**
 * @param {Record<string, unknown>} gitlab
 */
export function sshHostPort(gitlab) {
  const p =
    typeof gitlab.ssh_host_port === "number" ? gitlab.ssh_host_port : Number(gitlab.ssh_host_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 2222;
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/gitlab";
}

/**
 * Hostname from external_url (no scheme/path).
 * @param {string} externalUrl
 */
export function hostnameFromExternalUrl(externalUrl) {
  try {
    return new URL(externalUrl).hostname;
  } catch {
    return externalUrl.replace(/^https:\/\//i, "").split("/")[0] || "gitlab";
  }
}

/**
 * @param {Record<string, unknown>} gitlab
 */
export function renderOmnibusConfig(gitlab) {
  const externalUrl = normalizeExternalUrl(gitlab);
  const sshPort = sshHostPort(gitlab);
  const signups = gitlab.signups_enabled === true;

  const lines = [
    `external_url '${externalUrl.replace(/'/g, "'\\''")}'`,
    "nginx['listen_port'] = 80",
    "nginx['listen_https'] = false",
    "letsencrypt['enable'] = false",
    `gitlab_rails['gitlab_shell_ssh_port'] = ${sshPort}`,
    `gitlab_rails['gitlab_signup_enabled'] = ${signups}`,
  ];

  const mail = mailBlockFromService(gitlab);
  if (mail?.enabled === true) {
    const relay = loadMailRelayAppSettings();
    const recipients = resolveMailRecipients(mail, { from: relay.from });
    if (recipients) {
      const esc = (s) => String(s).replace(/'/g, "'\\''");
      lines.push(
        "gitlab_rails['smtp_enable'] = true",
        `gitlab_rails['smtp_address'] = '${esc(relay.host)}'`,
        `gitlab_rails['smtp_port'] = ${relay.port}`,
        "gitlab_rails['smtp_authentication'] = 'none'",
        "gitlab_rails['smtp_enable_starttls_auto'] = false",
        `gitlab_rails['gitlab_email_from'] = '${esc(recipients.from)}'`,
        `gitlab_rails['gitlab_email_reply_to'] = '${esc(recipients.from)}'`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} gitlab
 */
export function renderComposeYaml(gitlab) {
  const tag = normalizeImageTag(gitlab);
  const httpPort = hostPort(gitlab);
  const sshPort = sshHostPort(gitlab);
  const hostname = hostnameFromExternalUrl(normalizeExternalUrl(gitlab));
  const omnibus = renderOmnibusConfig(gitlab).trimEnd();

  return `services:
  gitlab:
    image: gitlab/gitlab-ce:${tag}
    container_name: gitlab
    restart: unless-stopped
    hostname: '${hostname.replace(/'/g, "''")}'
    shm_size: '256m'
    ports:
      - '${httpPort}:80'
      - '${sshPort}:22'
    volumes:
      - gitlab-config:/etc/gitlab
      - gitlab-logs:/var/log/gitlab
      - gitlab-data:/var/opt/gitlab
    environment:
      GITLAB_OMNIBUS_CONFIG: |
${omnibus
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}

volumes:
  gitlab-config: {}
  gitlab-logs: {}
  gitlab-data: {}
`;
}

/**
 * @param {Record<string, unknown>} gitlab
 */
export function resolveWebUrl(gitlab) {
  return normalizeExternalUrl(gitlab);
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} gitlab
 */
export function resolveUpstreamUrl(ctIp, gitlab) {
  const port = hostPort(gitlab);
  if (ctIp) return `http://${ctIp}:${port}`;
  return null;
}

/**
 * @param {string | null} ctIp
 * @param {Record<string, unknown>} gitlab
 */
export function resolveSshCloneHint(ctIp, gitlab) {
  const sshPort = sshHostPort(gitlab);
  const host = hostnameFromExternalUrl(normalizeExternalUrl(gitlab));
  if (ctIp) {
    return `ssh://git@${host}:${sshPort}/ (or git@${ctIp} port ${sshPort})`;
  }
  return `ssh://git@${host}:${sshPort}/`;
}
