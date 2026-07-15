import { vmNotSupportedResult } from "hdc/package/host-provisioner.mjs";
import { createAwsRunContext } from "./aws-run-context.mjs";
import { runAwsPlanApply, awsStdoutPayload } from "./aws-verb-common.mjs";

/**
 * Build a minimal EC2 deployment entry from a VmCreateSpec for service packages.
 * @param {string} systemId
 * @param {import("../../../lib/host-provisioner.mjs").VmCreateSpec} spec
 */
export function ec2DeploymentFromVmSpec(systemId, spec) {
  const p = /** @type {Record<string, unknown>} */ (spec.parameters ?? {});
  return {
    id: systemId,
    managed: true,
    name: spec.name,
    instance_type: (typeof p.instance_type === "string" && p.instance_type) || "t3.small",
    ami: p.ami ?? "ami-0c7217cd92b166775",
    subnet_id: p.subnet_id ?? "subnet-public-a",
    security_group_ids: Array.isArray(p.security_group_ids) ? p.security_group_ids : ["sg-web"],
    key_name: typeof p.key_name === "string" ? p.key_name : null,
    user_data: typeof p.user_data === "string" ? p.user_data : null,
    root_volume_gb: spec.diskGb ?? p.root_volume_gb ?? 30,
    root_volume_type: p.root_volume_type ?? "gp3",
    iam_instance_profile: typeof p.iam_instance_profile === "string" ? p.iam_instance_profile : null,
    tags: { Name: spec.name },
  };
}

/**
 * @param {object} ctx
 * @param {unknown} baseConfig Full or partial aws config from service deployment
 * @param {Record<string, string>} [flags]
 * @returns {import("../../../lib/host-provisioner.mjs").HostProvisioner}
 */
export function createAwsEc2HostProvisioner(ctx, baseConfig, flags = {}) {
  const log = ctx.log ?? ((s) => console.error(`[aws-ec2] ${s}`));

  return {
    backendId: "aws-ec2",

    async createContainer(logObj, spec) {
      logObj.info("aws-ec2 backend does not support createContainer; use aws-ecs");
      return {
        ok: false,
        message: "Use aws-ecs deploy mode for containers on AWS",
        details: { name: spec.name },
      };
    },

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} logObj
     * @param {import("../../../lib/host-provisioner.mjs").VmCreateSpec} spec
     */
    async createVm(logObj, spec) {
      try {
        const deployment = ec2DeploymentFromVmSpec(spec.name, spec);
        const cfg = {
          ...(typeof baseConfig === "object" && baseConfig ? baseConfig : {}),
          ec2_instances: [deployment],
        };
        const { config, client } = await createAwsRunContext(cfg);
        const outcome = await runAwsPlanApply({
          config,
          client,
          flags,
          resourceFilter: deployment.id,
          log: (line) => logObj.info(line),
        });
        const payload = awsStdoutPayload(outcome);
        if (outcome.aborted) {
          return {
            ok: false,
            message: outcome.dry_run ? "AWS EC2 dry-run (see cost estimate)" : "AWS EC2 deploy aborted",
            details: payload,
          };
        }
        const result = outcome.results.find((r) => r && typeof r === "object" && r.resource_id === deployment.id);
        return {
          ok: true,
          message: `EC2 instance ${deployment.id} provisioned`,
          details: {
            system_id: deployment.id,
            ip: result && typeof result === "object" ? result.private_ip : undefined,
            payload,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logObj.error(msg);
        return { ok: false, message: msg };
      }
    },
  };
}

/**
 * ECS Fargate provisioner stub — delegates to infrastructure aws clump config.
 * @param {object} ctx
 * @param {unknown} baseConfig
 * @param {Record<string, string>} [flags]
 */
export function createAwsEcsHostProvisioner(ctx, baseConfig, flags = {}) {
  const log = ctx.log ?? ((s) => console.error(`[aws-ecs] ${s}`));

  return {
    backendId: "aws-ecs",

    async createContainer(logObj, spec) {
      try {
        const p = /** @type {Record<string, unknown>} */ (spec.parameters ?? {});
        const serviceId = spec.name;
        const cfg = {
          ...(typeof baseConfig === "object" && baseConfig ? baseConfig : {}),
          ecs_services: [
            {
              id: serviceId,
              managed: true,
              cluster_id: p.cluster_id ?? "ecs-main",
              name: serviceId,
              cpu: p.cpu ?? 512,
              memory: p.memory ?? 1024,
              desired_count: 1,
              subnet_ids: p.subnet_ids ?? ["subnet-public-a"],
              security_group_ids: p.security_group_ids ?? ["sg-web"],
              task_definition: {
                containers: [
                  {
                    name: serviceId,
                    image: p.docker_image ?? "nginx:latest",
                    port_mappings: [{ container_port: p.container_port ?? 80, host_port: p.host_port ?? 80 }],
                  },
                ],
              },
            },
          ],
        };
        const { config, client } = await createAwsRunContext(cfg);
        const outcome = await runAwsPlanApply({
          config,
          client,
          flags,
          resourceFilter: serviceId,
          log: (line) => logObj.info(line),
        });
        const payload = awsStdoutPayload(outcome);
        if (outcome.aborted) {
          return {
            ok: false,
            message: outcome.dry_run ? "AWS ECS dry-run (see cost estimate)" : "AWS ECS deploy aborted",
            details: payload,
          };
        }
        return {
          ok: true,
          message: `ECS service ${serviceId} provisioned`,
          details: { system_id: serviceId, payload },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logObj.error(msg);
        return { ok: false, message: msg };
      }
    },

    async createVm(logObj) {
      logObj.warn(vmNotSupportedResult("aws-ecs").message ?? "VM not supported");
      return vmNotSupportedResult("aws-ecs");
    },
  };
}
