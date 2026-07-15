import { join } from "node:path";

import {
  clusterConfigByKey,
  isProxmoxConfigObject,
  loadProxmoxHostsByCluster,
} from "./proxmox-config.mjs";
import {
  authorizeProxmoxForClusterMembers,
  proxmoxMaintainVerifyPaths,
} from "./proxmox-deploy-auth.mjs";
import { loadProxmoxMaintainConfig } from "./proxmox-package-config.mjs";
import { lxcTemplateStorageFromConfig } from "./proxmox-provision-config.mjs";
import { pveFormBody, pveJsonRequest, pveDataArray } from "./pve-http.mjs";

const DEFAULT_SENDMAIL_TARGET = "hdc-mail";
const DEFAULT_BACKUP_FAILURE_MATCHER = "hdc-backup-failures";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function pveStringList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  }
  const single = String(value).trim();
  return single ? [single] : [];
}

/**
 * @param {unknown} cfg
 */
export function notificationsMaintainEnabledFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return false;
  const provision = cfg.provision;
  if (!isObject(provision)) return false;
  const notifications = provision.notifications;
  if (!isObject(notifications)) return false;
  if (notifications.enabled === false || notifications.enabled === 0) return false;
  return Boolean(notificationsMailtoFromConfig(cfg));
}

/**
 * @param {unknown} notificationsBlock
 */
export function notificationsMailtoFromBlock(notificationsBlock) {
  if (!isObject(notificationsBlock)) return "";
  const mailto = notificationsBlock.mailto;
  return typeof mailto === "string" && mailto.trim() ? mailto.trim() : "";
}

/**
 * @param {unknown} cfg
 */
export function notificationsMailtoFromConfig(cfg) {
  if (!isProxmoxConfigObject(cfg)) return "";
  const provision = cfg.provision;
  if (!isObject(provision)) return "";
  return notificationsMailtoFromBlock(provision.notifications);
}

/**
 * @param {unknown} cfg
 */
export function notificationsSpecFromConfig(cfg) {
  const mailto = notificationsMailtoFromConfig(cfg);
  if (!isProxmoxConfigObject(cfg) || !mailto) {
    return {
      mailto: "",
      sendmailTarget: DEFAULT_SENDMAIL_TARGET,
      backupFailureMatcher: DEFAULT_BACKUP_FAILURE_MATCHER,
      disableMatchers: [],
      disableLegacyBackupSuccessMatchers: true,
    };
  }
  const provision = cfg.provision;
  const notifications = isObject(provision) && isObject(provision.notifications) ? provision.notifications : {};
  const sendmailTarget =
    typeof notifications.sendmail_target === "string" && notifications.sendmail_target.trim()
      ? notifications.sendmail_target.trim()
      : DEFAULT_SENDMAIL_TARGET;
  const backupFailureMatcher =
    typeof notifications.backup_failure_matcher === "string" && notifications.backup_failure_matcher.trim()
      ? notifications.backup_failure_matcher.trim()
      : DEFAULT_BACKUP_FAILURE_MATCHER;
  const disableMatchers = pveStringList(notifications.disable_matchers);
  const disableLegacyBackupSuccessMatchers =
    notifications.disable_legacy_backup_success_matchers !== false &&
    notifications.disable_legacy_backup_success_matchers !== 0;
  return {
    mailto,
    sendmailTarget,
    backupFailureMatcher,
    disableMatchers,
    disableLegacyBackupSuccessMatchers,
  };
}

/**
 * Whether a matcher would route successful backup (vzdump info) notifications.
 * @param {Record<string, unknown>} matcher
 */
export function matcherMatchesVzdumpInfo(matcher) {
  if (matcher.disable === 1 || matcher.disable === true || matcher.disable === "1") return false;
  const severities = pveStringList(matcher["match-severity"]);
  if (severities.length && !severities.includes("info")) return false;
  const fields = pveStringList(matcher["match-field"]);
  if (!fields.length) return true;
  return fields.some((field) => {
    if (field === "exact:type=vzdump") return true;
    if (field.startsWith("exact:type=") && field.includes("vzdump")) return true;
    if (field.startsWith("regex:type=") && /vzdump/.test(field)) return true;
    return false;
  });
}

/**
 * @param {Record<string, unknown>} live
 * @param {{ mailto: string; sendmailTarget: string }} spec
 */
export function sendmailTargetMatches(live, spec) {
  const mailto = pveStringList(live.mailto);
  if (mailto.length !== 1 || mailto[0] !== spec.mailto) return false;
  const comment = String(live.comment ?? "").trim();
  return comment === "hdc-managed proxmox notifications";
}

/**
 * @param {Record<string, unknown>} live
 * @param {{ backupFailureMatcher: string; sendmailTarget: string }} spec
 */
export function backupFailureMatcherMatches(live, spec) {
  const fields = pveStringList(live["match-field"]);
  const severities = pveStringList(live["match-severity"]);
  const targets = pveStringList(live.target);
  if (!fields.includes("exact:type=vzdump")) return false;
  if (severities.length !== 1 || severities[0] !== "error") return false;
  if (!targets.includes(spec.sendmailTarget)) return false;
  if (live.disable === 1 || live.disable === true || live.disable === "1") return false;
  const mode = String(live.mode ?? "all").trim();
  if (mode && mode !== "all") return false;
  return true;
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
async function fetchSendmailEndpoints(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/notifications/endpoints/sendmail",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
async function fetchNotificationMatchers(apiBase, authorization, rejectUnauthorized) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    "/cluster/notifications/matchers",
    authorization,
    rejectUnauthorized,
    undefined,
  );
  return pveDataArray(body);
}

/**
 * @param {string} apiBase
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @param {string} name
 */
async function fetchNotificationMatcher(apiBase, authorization, rejectUnauthorized, name) {
  const body = await pveJsonRequest(
    "GET",
    apiBase,
    `/cluster/notifications/matchers/${encodeURIComponent(name)}`,
    authorization,
    rejectUnauthorized,
    undefined,
  );
  const data = body && typeof body === "object" && "data" in body ? body.data : body;
  return data && typeof data === "object" && !Array.isArray(data) ? /** @type {Record<string, unknown>} */ (data) : null;
}

/**
 * @param {object} opts
 * @param {string} opts.clumpRoot
 * @param {(line: string) => void} opts.log
 * @param {(line: string) => void} opts.warn
 * @param {boolean} opts.dryRun
 * @param {import("hdc/cli/lib/vault-access.mjs").ReturnType<import("hdc/cli/lib/vault-access.mjs").createVaultAccess>} [opts.vault]
 */
export async function runProxmoxNotificationsMaintain(opts) {
  const { clumpRoot, log, warn, dryRun, vault } = opts;
  const loaded = loadProxmoxMaintainConfig(clumpRoot, warn, "Notifications maintain");
  if (!loaded) {
    return { ok: true, skipped: false, results: [] };
  }
  const cfg = loaded.data;

  if (!notificationsMaintainEnabledFromConfig(cfg)) {
    log("notifications maintain: disabled or missing provision.notifications.mailto — skip.");
    return { ok: true, skipped: false, results: [] };
  }

  const spec = notificationsSpecFromConfig(cfg);
  const configPath = join(clumpRoot, "config.json");
  const configRel = "clumps/infrastructure/proxmox/config.json";
  const byCluster = loadProxmoxHostsByCluster(cfg, {
    configPath,
    configRel,
    onSkip: (id, reason) => warn(`skip host ${JSON.stringify(id)} (${reason})`),
  });
  const clusterKeys = [...byCluster.keys()].sort();
  if (!clusterKeys.length) {
    warn(`notifications maintain: no hypervisors in ${configRel}.`);
    return { ok: false, skipped: false, results: [] };
  }

  const lxcStorage = lxcTemplateStorageFromConfig(cfg);
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let ok = true;

  log(
    `notifications maintain: target ${JSON.stringify(spec.sendmailTarget)} matcher ${JSON.stringify(spec.backupFailureMatcher)} mailto ${JSON.stringify(spec.mailto)}${dryRun ? " [dry-run]" : ""}.`,
  );

  for (const clusterKey of clusterKeys) {
    const members = byCluster.get(clusterKey);
    if (!members?.length) continue;
    const lead = members[0];
    log(`Cluster ${JSON.stringify(clusterKey)}: reconcile notification targets/matchers …`);

    const configCluster = clusterConfigByKey(cfg, clusterKey);
    const auth = await authorizeProxmoxForClusterMembers({
      clumpRoot,
      members,
      vault,
      warn,
      log,
      configCluster,
      verifyPaths: proxmoxMaintainVerifyPaths(lead.pveNode, lxcStorage),
    });
    if (!auth) {
      ok = false;
      warn(`Skipping cluster ${JSON.stringify(clusterKey)} — no API token.`);
      continue;
    }

    /** @type {Record<string, unknown>[]} */
    let sendmailRows = [];
    /** @type {Record<string, unknown>[]} */
    let matcherRows = [];
    try {
      [sendmailRows, matcherRows] = await Promise.all([
        fetchSendmailEndpoints(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
        fetchNotificationMatchers(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized),
      ]);
    } catch (e) {
      ok = false;
      warn(`Cluster ${JSON.stringify(clusterKey)} notification API read failed: ${/** @type {Error} */ (e).message || e}`);
      continue;
    }

    const sendmailByName = new Map(
      sendmailRows.filter((r) => typeof r.name === "string").map((r) => [String(r.name), r]),
    );
    const matcherByName = new Map(
      matcherRows.filter((r) => typeof r.name === "string").map((r) => [String(r.name), r]),
    );

    const liveSendmail = sendmailByName.get(spec.sendmailTarget);
    if (liveSendmail && sendmailTargetMatches(liveSendmail, spec)) {
      log(`sendmail target ${JSON.stringify(spec.sendmailTarget)} OK.`);
      results.push({
        clusterKey,
        kind: "sendmail",
        name: spec.sendmailTarget,
        action: "unchanged",
        ok: true,
      });
    } else if (liveSendmail) {
      log(`sendmail target ${JSON.stringify(spec.sendmailTarget)} differs — will update${dryRun ? " [dry-run]" : ""}.`);
      results.push({
        clusterKey,
        kind: "sendmail",
        name: spec.sendmailTarget,
        action: "update",
        ok: dryRun ? true : undefined,
      });
      if (!dryRun) {
        try {
          const digest = typeof liveSendmail.digest === "string" ? liveSendmail.digest : undefined;
          const form = pveFormBody({
            mailto: [spec.mailto],
            comment: "hdc-managed proxmox notifications",
            ...(digest ? { digest } : {}),
          });
          await pveJsonRequest(
            "PUT",
            auth.host.apiBase,
            `/cluster/notifications/endpoints/sendmail/${encodeURIComponent(spec.sendmailTarget)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
          log(`sendmail target ${JSON.stringify(spec.sendmailTarget)} updated.`);
          results[results.length - 1].ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`sendmail target ${JSON.stringify(spec.sendmailTarget)} update failed: ${err}`);
          results[results.length - 1].ok = false;
          results[results.length - 1].error = err;
        }
      }
    } else {
      log(`sendmail target ${JSON.stringify(spec.sendmailTarget)} missing — will create${dryRun ? " [dry-run]" : ""}.`);
      results.push({
        clusterKey,
        kind: "sendmail",
        name: spec.sendmailTarget,
        action: "create",
        ok: dryRun ? true : undefined,
      });
      if (!dryRun) {
        try {
          const form = pveFormBody({
            name: spec.sendmailTarget,
            mailto: [spec.mailto],
            comment: "hdc-managed proxmox notifications",
          });
          await pveJsonRequest(
            "POST",
            auth.host.apiBase,
            "/cluster/notifications/endpoints/sendmail",
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
          log(`sendmail target ${JSON.stringify(spec.sendmailTarget)} created.`);
          results[results.length - 1].ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`sendmail target ${JSON.stringify(spec.sendmailTarget)} create failed: ${err}`);
          results[results.length - 1].ok = false;
          results[results.length - 1].error = err;
        }
      }
    }

    const liveMatcher = matcherByName.get(spec.backupFailureMatcher);
    if (liveMatcher && backupFailureMatcherMatches(liveMatcher, spec)) {
      log(`matcher ${JSON.stringify(spec.backupFailureMatcher)} OK.`);
      results.push({
        clusterKey,
        kind: "matcher",
        name: spec.backupFailureMatcher,
        action: "unchanged",
        ok: true,
      });
    } else if (liveMatcher) {
      log(`matcher ${JSON.stringify(spec.backupFailureMatcher)} differs — will update${dryRun ? " [dry-run]" : ""}.`);
      results.push({
        clusterKey,
        kind: "matcher",
        name: spec.backupFailureMatcher,
        action: "update",
        ok: dryRun ? true : undefined,
      });
      if (!dryRun) {
        try {
          const detailed =
            (await fetchNotificationMatcher(
              auth.host.apiBase,
              auth.authorization,
              auth.rejectUnauthorized,
              spec.backupFailureMatcher,
            )) ?? liveMatcher;
          const digest = typeof detailed.digest === "string" ? detailed.digest : undefined;
          const form = pveFormBody({
            "match-field": ["exact:type=vzdump"],
            "match-severity": ["error"],
            target: [spec.sendmailTarget],
            mode: "all",
            disable: 0,
            comment: "hdc-managed: backup failures only",
            ...(digest ? { digest } : {}),
          });
          await pveJsonRequest(
            "PUT",
            auth.host.apiBase,
            `/cluster/notifications/matchers/${encodeURIComponent(spec.backupFailureMatcher)}`,
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
          log(`matcher ${JSON.stringify(spec.backupFailureMatcher)} updated.`);
          results[results.length - 1].ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`matcher ${JSON.stringify(spec.backupFailureMatcher)} update failed: ${err}`);
          results[results.length - 1].ok = false;
          results[results.length - 1].error = err;
        }
      }
    } else {
      log(`matcher ${JSON.stringify(spec.backupFailureMatcher)} missing — will create${dryRun ? " [dry-run]" : ""}.`);
      results.push({
        clusterKey,
        kind: "matcher",
        name: spec.backupFailureMatcher,
        action: "create",
        ok: dryRun ? true : undefined,
      });
      if (!dryRun) {
        try {
          const form = pveFormBody({
            name: spec.backupFailureMatcher,
            "match-field": ["exact:type=vzdump"],
            "match-severity": ["error"],
            target: [spec.sendmailTarget],
            mode: "all",
            disable: 0,
            comment: "hdc-managed: backup failures only",
          });
          await pveJsonRequest(
            "POST",
            auth.host.apiBase,
            "/cluster/notifications/matchers",
            auth.authorization,
            auth.rejectUnauthorized,
            form,
          );
          log(`matcher ${JSON.stringify(spec.backupFailureMatcher)} created.`);
          results[results.length - 1].ok = true;
        } catch (e) {
          ok = false;
          const err = /** @type {Error} */ (e).message || String(e);
          warn(`matcher ${JSON.stringify(spec.backupFailureMatcher)} create failed: ${err}`);
          results[results.length - 1].ok = false;
          results[results.length - 1].error = err;
        }
      }
    }

    /** @type {Set<string>} */
    const disableNames = new Set(spec.disableMatchers);
    if (spec.disableLegacyBackupSuccessMatchers) {
      for (const [name, matcher] of matcherByName.entries()) {
        if (name === spec.backupFailureMatcher) continue;
        if (!matcherMatchesVzdumpInfo(matcher)) continue;
        disableNames.add(name);
      }
    }

    for (const name of [...disableNames].sort()) {
      const matcher = matcherByName.get(name);
      if (!matcher) {
        warn(`matcher ${JSON.stringify(name)} listed for disable but not found — skip.`);
        continue;
      }
      if (matcher.disable === 1 || matcher.disable === true || matcher.disable === "1") {
        log(`matcher ${JSON.stringify(name)} already disabled.`);
        results.push({ clusterKey, kind: "matcher", name, action: "disabled-unchanged", ok: true });
        continue;
      }
      log(`matcher ${JSON.stringify(name)} notifies on backup success — will disable${dryRun ? " [dry-run]" : ""}.`);
      results.push({
        clusterKey,
        kind: "matcher",
        name,
        action: "disable",
        ok: dryRun ? true : undefined,
      });
      if (dryRun) continue;
      try {
        const detailed =
          (await fetchNotificationMatcher(auth.host.apiBase, auth.authorization, auth.rejectUnauthorized, name)) ??
          matcher;
        const digest = typeof detailed.digest === "string" ? detailed.digest : undefined;
        const form = pveFormBody({
          disable: 1,
          ...(digest ? { digest } : {}),
        });
        await pveJsonRequest(
          "PUT",
          auth.host.apiBase,
          `/cluster/notifications/matchers/${encodeURIComponent(name)}`,
          auth.authorization,
          auth.rejectUnauthorized,
          form,
        );
        log(`matcher ${JSON.stringify(name)} disabled.`);
        results[results.length - 1].ok = true;
      } catch (e) {
        ok = false;
        const err = /** @type {Error} */ (e).message || String(e);
        warn(`matcher ${JSON.stringify(name)} disable failed: ${err}`);
        results[results.length - 1].ok = false;
        results[results.length - 1].error = err;
      }
    }
  }

  return { ok, skipped: false, results };
}
