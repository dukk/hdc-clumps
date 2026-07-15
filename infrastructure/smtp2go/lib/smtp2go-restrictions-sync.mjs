import { normalizeIpAddress } from "./smtp2go-config.mjs";

/**
 * @typedef {import('./smtp2go-config.mjs').ConfigIpAllowList} ConfigIpAllowList
 * @typedef {import('./smtp2go-config.mjs').ConfigAllowedSenders} ConfigAllowedSenders
 * @typedef {import('./smtp2go-api.mjs').Smtp2goIpAllowListState} Smtp2goIpAllowListState
 * @typedef {import('./smtp2go-api.mjs').Smtp2goAllowedSendersState} Smtp2goAllowedSendersState
 */

/**
 * @param {object} opts
 * @param {ConfigIpAllowList} opts.config
 * @param {Smtp2goIpAllowListState | null} opts.live
 * @param {boolean} [opts.prune]
 */
export function planIpAllowListSync(opts) {
  const { config, live, prune = false } = opts;

  if (!config.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      reason: "not managed",
      steps: [],
    };
  }

  /** @type {Record<string, unknown>[]} */
  const steps = [];

  const liveEnabled = live?.enabled === true;
  if (config.enabled !== liveEnabled) {
    steps.push({ type: "set_enabled", enabled: config.enabled });
  }

  const liveByIp = new Map(
    (Array.isArray(live?.ip_addresses) ? live.ip_addresses : [])
      .map((row) => {
        const ip =
          typeof row.ip_address === "string" ? normalizeIpAddress(row.ip_address) : "";
        return ip ? [ip, row] : null;
      })
      .filter(Boolean)
  );

  const configIps = new Set(config.entries.map((e) => normalizeIpAddress(e.ip_address)));

  for (const entry of config.entries) {
    const ip = normalizeIpAddress(entry.ip_address);
    const liveRow = liveByIp.get(ip);
    if (!liveRow) {
      steps.push({
        type: "add",
        ip_address: ip,
        description: entry.description ?? undefined,
      });
      continue;
    }
    const liveDesc =
      typeof liveRow.description === "string" ? liveRow.description.trim() || null : null;
    const configDesc = entry.description ?? null;
    if (configDesc !== liveDesc) {
      steps.push({
        type: "edit_description",
        ip_address: ip,
        description: configDesc ?? "",
      });
    }
  }

  if (prune) {
    for (const ip of liveByIp.keys()) {
      if (!configIps.has(ip)) {
        steps.push({ type: "remove", ip_address: ip });
      }
    }
  }

  if (!steps.length) {
    return { action: /** @type {"unchanged"} */ ("unchanged"), steps: [] };
  }

  return { action: /** @type {"sync"} */ ("sync"), steps };
}

/**
 * @param {object} opts
 * @param {ConfigAllowedSenders} opts.config
 * @param {Smtp2goAllowedSendersState | null} opts.live
 */
export function planAllowedSendersSync(opts) {
  const { config, live } = opts;

  if (!config.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      reason: "not managed",
    };
  }

  const liveMode =
    live?.mode === "whitelist" || live?.mode === "blacklist" ? live.mode : "disabled";
  const liveSenders = Array.isArray(live?.allowed_senders) ? live.allowed_senders : [];

  const modeDiff = config.mode !== liveMode;
  const sendersDiff =
    JSON.stringify([...config.senders].sort()) !==
    JSON.stringify([...liveSenders].sort((a, b) => a.localeCompare(b)));

  if (!modeDiff && !sendersDiff) {
    return { action: /** @type {"unchanged"} */ ("unchanged") };
  }

  return {
    action: /** @type {"update"} */ ("update"),
    mode: config.mode,
    allowed_senders: config.senders,
  };
}

/**
 * @param {ReturnType<import('./smtp2go-api.mjs').createSmtp2goClient>} api
 * @param {ReturnType<typeof planIpAllowListSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyIpAllowListSync(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip IP allowlist (${plan.reason})`);
    return { ok: true, action: "skip" };
  }

  if (plan.action === "unchanged") {
    log("unchanged IP allowlist");
    return { ok: true, action: "unchanged" };
  }

  /** @type {Record<string, unknown>[]} */
  const applied = [];

  for (const step of plan.steps) {
    try {
      if (step.type === "set_enabled") {
        if (dryRun) {
          log(`dry-run: would set IP allowlist enabled=${step.enabled}`);
        } else {
          await api.setIpAllowListEnabled(step.enabled === true);
          log(`set IP allowlist enabled=${step.enabled}`);
        }
        applied.push(step);
        continue;
      }

      if (step.type === "add") {
        if (dryRun) {
          log(`dry-run: would add IP allowlist ${step.ip_address}`);
        } else {
          await api.addIpAllowListEntry({
            ip_address: String(step.ip_address),
            description:
              typeof step.description === "string" ? step.description : undefined,
          });
          log(`added IP allowlist ${step.ip_address}`);
        }
        applied.push(step);
        continue;
      }

      if (step.type === "edit_description") {
        if (dryRun) {
          log(`dry-run: would edit IP allowlist ${step.ip_address} description`);
        } else {
          await api.editIpAllowListEntry({
            ip_address: String(step.ip_address),
            description: String(step.description ?? ""),
          });
          log(`updated IP allowlist ${step.ip_address} description`);
        }
        applied.push(step);
        continue;
      }

      if (step.type === "remove") {
        if (dryRun) {
          log(`dry-run: would remove IP allowlist ${step.ip_address}`);
        } else {
          await api.removeIpAllowListEntry(String(step.ip_address));
          log(`removed IP allowlist ${step.ip_address}`);
        }
        applied.push(step);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed IP allowlist step ${step.type}: ${msg}`);
      return { ok: false, action: "sync", error: msg, applied };
    }
  }

  return { ok: true, action: "sync", applied };
}

/**
 * @param {ReturnType<import('./smtp2go-api.mjs').createSmtp2goClient>} api
 * @param {ReturnType<typeof planAllowedSendersSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void }} [opts]
 */
export async function applyAllowedSendersSync(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip allowed senders (${plan.reason})`);
    return { ok: true, action: "skip" };
  }

  if (plan.action === "unchanged") {
    log("unchanged allowed senders");
    return { ok: true, action: "unchanged" };
  }

  try {
    if (dryRun) {
      log(
        `dry-run: would update allowed senders mode=${plan.mode} (${plan.allowed_senders?.length ?? 0} sender(s))`
      );
      return { ok: true, action: "update", dryRun: true };
    }
    await api.updateAllowedSenders({
      mode: plan.mode,
      allowed_senders: plan.allowed_senders ?? [],
    });
    log(
      `updated allowed senders mode=${plan.mode} (${plan.allowed_senders?.length ?? 0} sender(s))`
    );
    return { ok: true, action: "update" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed allowed senders update: ${msg}`);
    return { ok: false, action: "update", error: msg };
  }
}
