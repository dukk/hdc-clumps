import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { mailBlockFromService } from "hdc/package/app-mail-render.mjs";
import { loadMailRelayAppSettings, mailEnabledFromConfig } from "hdc/package/mail-relay-settings.mjs";

/**
 * Apply Nextcloud AIO SMTP settings via occ when the nextcloud container is running.
 * @param {string} user
 * @param {string} pveHost
 * @param {number} vmid
 * @param {Record<string, unknown>} nextcloud
 */
export function applyNextcloudMailInCt(user, pveHost, vmid, nextcloud) {
  const mail = mailBlockFromService(nextcloud);
  if (!mailEnabledFromConfig(mail)) {
    return { ok: true, skipped: true, message: "mail not enabled in config" };
  }

  const relay = loadMailRelayAppSettings();
  const from =
    mail && typeof mail.from === "string" && mail.from.trim() ? mail.from.trim() : relay.from;

  const esc = (s) => String(s).replace(/'/g, `'\\''`);
  const inner = [
    "set -e",
    'docker ps --format "{{.Names}}" | grep -qx nextcloud-aio-nextcloud || { echo "nextcloud-aio-nextcloud not running — skip mail occ"; exit 0; }',
    `docker exec -u www-data nextcloud-aio-nextcloud php occ config:system:set mail_smtphost --value='${esc(relay.host)}'`,
    `docker exec -u www-data nextcloud-aio-nextcloud php occ config:system:set mail_smtpport --value='${relay.port}' --type=integer`,
    "docker exec -u www-data nextcloud-aio-nextcloud php occ config:system:set mail_smtpauth --value=0 --type=integer",
    `docker exec -u www-data nextcloud-aio-nextcloud php occ config:system:set mail_smtpname --value=''`,
    `docker exec -u www-data nextcloud-aio-nextcloud php occ config:system:set mail_smtppassword --value=''`,
    `docker exec -u www-data nextcloud-aio-nextcloud php occ config:system:set mail_from_address --value='${esc(from.split("@")[0] || "noreply")}'`,
    `docker exec -u www-data nextcloud-aio-nextcloud php occ config:system:set mail_domain --value='${esc(from.includes("@") ? from.split("@").slice(1).join("@") : relay.myorigin)}'`,
  ].join("\n");

  const r = pctExec(user, pveHost, vmid, inner, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim();
    return { ok: false, message: detail || `exit ${r.status}` };
  }
  return { ok: true, message: "Nextcloud mail settings applied via occ" };
}
