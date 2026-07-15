import { attachCostReportToPayload } from "hdc/package/cost-report.mjs";
import { confirmDeployCost } from "hdc/package/deploy-cost-confirm.mjs";
import { collectOciLiveState } from "./oci-collect.mjs";
import { estimatePlanCost } from "./oci-cost-estimate.mjs";
import { planHasCreates, planOciSync, expandedResourceFilter } from "./oci-plan.mjs";
import { applyOciPlan } from "./oci-sync.mjs";

/** @typedef {import("./oci-config.mjs").NormalizedOciComputeConfig} NormalizedOciComputeConfig */
/** @typedef {import("./oci-api.mjs").OciClient} OciClient */

/**
 * @param {object} opts
 * @param {NormalizedOciComputeConfig} opts.config
 * @param {OciClient} opts.client
 * @param {Record<string, string>} opts.flags
 * @param {boolean} [opts.prune]
 * @param {string | null} [opts.resourceFilter]
 * @param {(line: string) => void} opts.log
 */
export async function runOciPlanApply(opts) {
  const dryRun = opts.flags["dry-run"] === "1" || opts.flags.dry_run === "1";
  const live = await collectOciLiveState(opts.client, opts.config);
  const actions = planOciSync({
    config: opts.config,
    live,
    prune: opts.prune ?? false,
    resourceFilter: opts.resourceFilter ?? null,
  });

  const createsOrUpdates = actions.filter((a) => a.action === "create" || a.action === "update");
  const deletes = actions.filter((a) => a.action === "delete");
  const estimate = estimatePlanCost(actions);

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
      live,
    };
  }

  const resourceFilter = opts.resourceFilter ?? null;
  /** @type {(resourceId: string) => boolean} */
  const matchResource = resourceFilter
    ? (id) => expandedResourceFilter(opts.config, resourceFilter)?.has(id) ?? false
    : () => true;

  const results = await applyOciPlan({
    client: opts.client,
    config: opts.config,
    live,
    actions: createsOrUpdates.concat(deletes),
    dryRun,
    log: opts.log,
    matchResource,
  });

  return {
    ok: true,
    aborted: false,
    dry_run: dryRun,
    actions,
    estimate,
    confirm,
    results,
    live,
  };
}

/**
 * @param {Awaited<ReturnType<typeof runOciPlanApply>>} outcome
 */
export function ociStdoutPayload(outcome) {
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
