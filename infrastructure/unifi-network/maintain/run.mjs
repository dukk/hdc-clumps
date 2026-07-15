#!/usr/bin/env node
/**
 * UniFi Network maintain: apply config port_forwards[] and/or HDC IP blocks.
 *
 * Usage: hdc run infrastructure unifi-network maintain --
 *   [--dry-run] [--prune] [--rule <id>]
 *   [--block <ip> --days 30 --reason <text>] [--unblock <ip>] [--prune-expired]
 *   [--no-report] [--report <path>]
 *
 * Operator one-time: create a UniFi WAN_IN DROP firewall policy whose source
 * matches the hdc-auto-block address group (hdc creates/updates the group).
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { parseArgvFlags, flagGet } from "hdc/package/parse-argv-flags.mjs";
import {
  createOperationReportContext,
  recordStep,
  runOperationReportTail,
  setOutcome,
  setStdoutPayload,
  pushWarning,
} from "hdc/package/operation-report.mjs";
import { repoRoot } from "hdc/cli/paths.mjs";
import { createUnifiRunContext, fetchLivePortForwards } from "hdc/package/unifi-collect.mjs";
import { portForwardPassesFilter } from "hdc/package/unifi-config.mjs";
import { applyPortForwardSync, planPortForwardSync } from "hdc/package/unifi-port-forward-sync.mjs";
import {
  DEFAULT_NEVER_BLOCK_CIDRS,
  activeBlockIps,
  ensureFirewallAddressGroup,
  loadIpBlocksLedger,
  planBlockIp,
  planUnblockIp,
  pruneExpiredBlocks,
  resolveIpBlocksPath,
  saveIpBlocksLedger,
} from "hdc/package/unifi-ip-block.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

const MANIFEST_NEXT_STEPS = [
  "Run `hdc run infrastructure unifi-network query --` to verify diffs after maintain.",
  "Bootstrap from live: `query -- --import-port-forwards --yes`.",
  "IP blocks: ensure a WAN_IN DROP policy uses the hdc-auto-block address group.",
];

/**
 * @param {string} line
 */
function log(line) {
  errout.write(`[unifi-network] ${line}\n`);
}

/**
 * @param {ReturnType<typeof parseArgvFlags>} flags
 */
function parseDays(flags) {
  const raw = flagGet(flags, "days");
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgvFlags(argv);
  const ruleId = flagGet(flags, "rule");
  const prune = flags.prune === "1";
  const blockIp = flagGet(flags, "block");
  const unblockIp = flagGet(flags, "unblock");
  const pruneExpired = flags["prune-expired"] === "1";
  const reason = flagGet(flags, "reason") ?? undefined;
  const daysFlag = parseDays(flags);

  if (blockIp && unblockIp) {
    throw new Error("use only one of --block / --unblock");
  }

  const ipBlockMode = Boolean(blockIp || unblockIp || pruneExpired);

  const reportCtx = createOperationReportContext({
    clumpId: "unifi-network",
    clumpTitle: "UniFi Network",
    verb,
    argv,
    manifestNextSteps: MANIFEST_NEXT_STEPS,
    extraFlags: {
      prune,
      rule: ruleId ?? null,
      block: blockIp ?? null,
      unblock: unblockIp ?? null,
      prune_expired: pruneExpired,
    },
  });

  log(
    `${verb}: starting${reportCtx.dryRun ? " (dry-run)" : ""}${prune ? " (prune)" : ""}${ipBlockMode ? " (ip-block)" : ""}`,
  );

  const ctx = await createUnifiRunContext({ clumpRoot, log });
  log(`config loaded (${ctx.configSource})`);

  /** @type {Record<string, unknown>} */
  const stdoutPayload = { site_id: ctx.siteId };
  let overallOk = true;

  if (ipBlockMode) {
    const ledgerPath = resolveIpBlocksPath(repoRoot());
    let ledger = loadIpBlocksLedger(ledgerPath);
    const ipCfg = ctx.config.ipBlock ?? { groupName: "hdc-auto-block", neverBlockCidrs: [], defaultDays: 30 };
    ledger = { ...ledger, group_name: ipCfg.groupName || ledger.group_name };
    const neverCidrs =
      ipCfg.neverBlockCidrs && ipCfg.neverBlockCidrs.length
        ? ipCfg.neverBlockCidrs
        : DEFAULT_NEVER_BLOCK_CIDRS;

    if (pruneExpired) {
      const pruned = pruneExpiredBlocks(ledger);
      ledger = pruned.ledger;
      log(`prune-expired: removed ${pruned.removed.length} expired block(s)`);
      recordStep(reportCtx, {
        id: "ip-block-prune-expired",
        title: "Prune expired IP blocks",
        ran: true,
        ok: true,
        notes: pruned.removed.map((b) => `expired ${b.ip}`),
      });
    }

    if (blockIp) {
      const planned = planBlockIp({
        ip: blockIp,
        days: daysFlag ?? ipCfg.defaultDays,
        reason,
        neverBlockCidrs: neverCidrs,
        ledger,
      });
      if (!planned.ok) {
        throw new Error(planned.error ?? "block failed");
      }
      ledger = planned.ledger;
      log(
        `block ${planned.entry.ip} until ${planned.entry.expires_at}${reason ? ` (${reason})` : ""}`,
      );
      recordStep(reportCtx, {
        id: "ip-block-add",
        title: `Block ${planned.entry.ip}`,
        ran: true,
        ok: true,
        notes: [`expires ${planned.entry.expires_at}`, reason ? `reason: ${reason}` : ""].filter(Boolean),
      });
    }

    if (unblockIp) {
      const planned = planUnblockIp({ ip: unblockIp, ledger });
      ledger = planned.ledger;
      log(`unblock ${unblockIp} (removed ${planned.removed})`);
      recordStep(reportCtx, {
        id: "ip-block-remove",
        title: `Unblock ${unblockIp}`,
        ran: true,
        ok: true,
        notes: [`removed ${planned.removed}`],
      });
    }

    const members = activeBlockIps(ledger);
    const groupResult = await ensureFirewallAddressGroup({
      base: ctx.base,
      apiKey: ctx.apiKey,
      classicSiteKey: ctx.classicSiteKey,
      rejectUnauthorized: ctx.rejectUnauthorized,
      groupName: ledger.group_name,
      members,
      dryRun: reportCtx.dryRun,
      log,
    });

    if (!reportCtx.dryRun) {
      saveIpBlocksLedger(ledgerPath, ledger);
      log(`wrote ${ledgerPath}`);
    } else {
      log(`dry-run: would write ${ledgerPath}`);
    }

    stdoutPayload.ip_block = {
      group_name: ledger.group_name,
      active_members: members,
      ledger_path: ledgerPath,
      group: groupResult,
    };
    recordStep(reportCtx, {
      id: "ip-block-sync-group",
      title: "Sync UniFi address group",
      ran: true,
      ok: true,
      notes: [
        `group ${ledger.group_name}`,
        `members ${members.length}`,
        groupResult.action,
        "Ensure a WAN_IN DROP policy uses this address group.",
      ],
    });
  }

  // Default: IP-block-only invocations skip port-forward sync unless --with-port-forwards.
  // Full maintain (no block flags) still syncs port forwards.
  const runPortForwards = ipBlockMode ? flags["with-port-forwards"] === "1" : true;

  if (runPortForwards) {
    const desired = ctx.config.managedPortForwards.filter((p) => portForwardPassesFilter(p, ruleId));
    if (!desired.length) {
      throw new Error(
        ruleId
          ? `No managed port_forwards[] entry with id ${ruleId}`
          : "No managed port_forwards[] entries in config",
      );
    }

    log(
      `Applying ${desired.length} managed port forward rule(s) (integration site ${ctx.siteId}, classic site ${ctx.classicSiteKey})`,
    );
    const liveRows = await fetchLivePortForwards(ctx, log);
    log(`Using classic site key "${ctx.classicSiteKey}" for writes`);

    let plan;
    try {
      plan = planPortForwardSync(desired, liveRows, prune);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`plan failed: ${msg}`);
    }

    log(
      `plan: create=${plan.summary.create} update=${plan.summary.update} (disable-first) delete=${plan.summary.delete} unchanged=${plan.summary.unchanged}`,
    );

    const applyResult = await applyPortForwardSync(ctx, plan, {
      dryRun: reportCtx.dryRun,
      log,
    });

    recordStep(reportCtx, {
      id: "port-forward-sync",
      title: "Sync port forwards",
      ran: true,
      ok: applyResult.ok,
      notes: [
        `create ${plan.summary.create}, update ${plan.summary.update}, delete ${plan.summary.delete}, unchanged ${plan.summary.unchanged}`,
        ...(applyResult.results.filter((r) => !r.ok).map((r) => `${r.action} ${r.key}: ${r.error}`)),
      ],
    });

    if (!applyResult.ok) {
      overallOk = false;
      pushWarning(reportCtx, "One or more port forward changes failed");
    }
    stdoutPayload.plan = plan.summary;
    stdoutPayload.results = applyResult.results;
  } else {
    log("Skipping port-forward sync (IP-block mode; pass --with-port-forwards to include)");
  }

  setOutcome(reportCtx, {
    ok: overallOk,
    dryRun: reportCtx.dryRun,
    exitCode: overallOk ? 0 : 1,
  });
  setStdoutPayload(reportCtx, stdoutPayload);

  await runOperationReportTail({
    ctx: reportCtx,
    clumpRoot,
    repoRoot: repoRoot(),
    verb,
    argv,
    log,
    ok: overallOk,
    payload: reportCtx.stdoutPayload,
  });

  log(overallOk ? `${verb}: completed successfully` : `${verb}: completed with errors`);
  process.exitCode = overallOk ? 0 : 1;
}

main().catch(async (e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
