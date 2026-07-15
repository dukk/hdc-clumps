import {
  applyEc2Action,
  applyEbsAction,
  applyIamAction,
} from "./aws-ec2.mjs";
import {
  applyEcsClusterAction,
  applyEcsServiceAction,
} from "./aws-ecs.mjs";
import { applyS3Action } from "./aws-s3.mjs";
import {
  applySecurityGroupAction,
  applySubnetAction,
  applyVpcAction,
} from "./aws-vpc.mjs";

/** @typedef {import("./aws-plan.mjs").AwsPlanAction} AwsPlanAction */
/** @typedef {ReturnType<import("./aws-api.mjs").createAwsClient>} AwsClient */

/**
 * @param {object} opts
 * @param {AwsClient} opts.client
 * @param {AwsPlanAction[]} opts.actions
 * @param {boolean} opts.dryRun
 * @param {(line: string) => void} [opts.log]
 */
export async function applyAwsPlan(opts) {
  const { client, actions, dryRun, log = () => {} } = opts;
  /** @type {Record<string, unknown>[]} */
  const results = [];

  const vpcIdMap = new Map();
  const subnetIdMap = new Map();
  const sgIdMap = new Map();
  const ec2IdMap = new Map();
  const ebsIdMap = new Map();
  const clusterIdMap = new Map();

  for (const action of actions) {
    if (action.action === "noop") continue;
    if (dryRun && action.action !== "delete") {
      log(`[dry-run] would ${action.action} ${action.kind} ${action.resource_id}`);
      results.push({ resource_id: action.resource_id, kind: action.kind, action: action.action, dry_run: true });
      continue;
    }

    try {
      let res = null;
      switch (action.kind) {
        case "iam_role":
          res = await applyIamAction(client, action);
          break;
        case "vpc":
          res = await applyVpcAction(client, action, vpcIdMap, dryRun);
          break;
        case "subnet":
          res = await applySubnetAction(client, action, vpcIdMap, subnetIdMap, dryRun);
          break;
        case "security_group":
          res = await applySecurityGroupAction(client, action, vpcIdMap, sgIdMap, dryRun);
          break;
        case "ebs_volume":
          res = await applyEbsAction(client, action, ebsIdMap, dryRun);
          break;
        case "ec2_instance":
          res = await applyEc2Action(client, action, subnetIdMap, sgIdMap, ec2IdMap, dryRun);
          break;
        case "s3_bucket":
          res = await applyS3Action(client, action);
          break;
        case "ecs_cluster":
          res = await applyEcsClusterAction(client, action, clusterIdMap);
          break;
        case "ecs_service":
          res = await applyEcsServiceAction(client, action, clusterIdMap, subnetIdMap, sgIdMap);
          break;
        default:
          log(`skip unsupported kind ${action.kind}`);
      }
      if (res) {
        log(`${action.action} ${action.kind} ${action.resource_id}: ok`);
        results.push({ ...res, kind: action.kind, action: action.action });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${action.action} ${action.kind} ${action.resource_id}: failed — ${msg}`);
      results.push({
        resource_id: action.resource_id,
        kind: action.kind,
        action: action.action,
        ok: false,
        error: msg,
      });
      throw err;
    }
  }

  return results;
}
