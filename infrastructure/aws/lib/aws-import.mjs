import { resolveRepoFile, writeResolvedRepoJson } from "hdc/cli/lib/private-repo.mjs";

/** @typedef {import("./aws-config.mjs").NormalizedAwsConfig} NormalizedAwsConfig */

export const PACKAGE_CONFIG_REL = "clumps/infrastructure/aws/config.json";

/**
 * @param {Record<string, Map<string, Record<string, unknown>>>} liveByKind
 * @param {NormalizedAwsConfig} existing
 */
export function buildImportConfig(liveByKind, existing) {
  void liveByKind;
  /** @type {Record<string, unknown>} */
  const out = {
    schema_version: existing.schema_version,
    aws: { region: existing.region, default_tags: existing.default_tags },
    cost: {
      confirm_before_deploy: existing.confirm_before_deploy,
      hours_per_month: existing.hours_per_month,
    },
    vpcs: existing.vpcs,
    subnets: existing.subnets,
    security_groups: existing.security_groups,
    iam_roles: existing.iam_roles,
    ebs_volumes: existing.ebs_volumes,
    ec2_instances: existing.ec2_instances,
    s3_buckets: existing.s3_buckets,
    ecs_clusters: existing.ecs_clusters,
    ecs_services: existing.ecs_services,
  };
  return out;
}

/**
 * @param {string} publicRoot
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function writeAwsConfigImport(publicRoot, config) {
  const resolved = resolveRepoFile(publicRoot, PACKAGE_CONFIG_REL);
  writeResolvedRepoJson(resolved, config);
  return resolved.path;
}
