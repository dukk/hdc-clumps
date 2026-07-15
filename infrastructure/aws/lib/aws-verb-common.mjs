import { attachCostReportToPayload } from "hdc/package/cost-report.mjs";
import { confirmDeployCost } from "hdc/package/deploy-cost-confirm.mjs";
import { collectAwsLiveState } from "./aws-collect.mjs";
import { planAwsSync, planHasCreates } from "./aws-plan.mjs";
import { estimatePlanCost } from "./aws-pricing.mjs";
import { applyAwsPlan } from "./aws-sync.mjs";

/** @typedef {import("./aws-config.mjs").NormalizedAwsConfig} NormalizedAwsConfig */
/** @typedef {ReturnType<import("./aws-api.mjs").createAwsClient>} AwsClient */

/**
 * @param {object} opts
 * @param {NormalizedAwsConfig} opts.config
 * @param {AwsClient} opts.client
 * @param {Record<string, string>} opts.flags
 * @param {boolean} [opts.prune]
 * @param {string} [opts.resourceFilter]
 * @param {(line: string) => void} opts.log
 */
export async function runAwsPlanApply(opts) {
  const dryRun = opts.flags["dry-run"] === "1" || opts.flags.dry_run === "1";
  const liveByKind = await collectAwsLiveState(opts.client);
  const actions = planAwsSync({
    config: opts.config,
    liveByKind,
    prune: opts.prune ?? false,
    resourceFilter: opts.resourceFilter,
  });

  const createsOrUpdates = actions.filter((a) => a.action === "create" || a.action === "update");
  const estimate = await estimatePlanCost(actions, opts.config);

  const confirm = await confirmDeployCost({
    estimate,
    flags: opts.flags,
    confirmBeforeDeploy: opts.config.confirm_before_deploy,
    log: opts.log,
    hasCreates: planHasCreates(actions),
  });

  if (!confirm.proceed) {
    return {
      ok: true,
      aborted: true,
      dry_run: dryRun,
      actions,
      estimate,
      confirm,
      results: [],
    };
  }

  const results = await applyAwsPlan({
    client: opts.client,
    actions: createsOrUpdates.concat(actions.filter((a) => a.action === "delete")),
    dryRun,
    log: opts.log,
  });

  return {
    ok: true,
    aborted: false,
    dry_run: dryRun,
    actions,
    estimate,
    confirm,
    results,
  };
}

/**
 * @param {Awaited<ReturnType<typeof runAwsPlanApply>>} outcome
 */
export function awsStdoutPayload(outcome) {
  /** @type {Record<string, unknown>} */
  const payload = {
    ok: outcome.ok,
    aborted: outcome.aborted,
    dry_run: outcome.dry_run,
    plan_summary: outcome.actions.map((a) => ({
      kind: a.kind,
      resource_id: a.resource_id,
      action: a.action,
    })),
    results: outcome.results,
  };
  attachCostReportToPayload(payload, {
    estimate: outcome.estimate,
    confirmed: outcome.confirm.confirmed,
    skipped_confirm: outcome.confirm.skipped,
    dry_run_only: outcome.aborted && outcome.dry_run,
  });
  return payload;
}
