import { vmNotSupportedResult } from "hdc/package/host-provisioner.mjs";
import { deployComposeStack, teardownComposeStack } from "./synology-docker-compose.mjs";
import { ensureSynologyDocker } from "./synology-docker-ensure.mjs";
import { synologyRemoteExec } from "./synology-ssh.mjs";

/**
 * @param {object} ctx
 * @param {object} ctx.execOpts synologyRemoteExec options (target, auth, spawnSync, env, identities)
 * @param {{ dryRun?: boolean }} [ctx.opts]
 * @returns {import("../../../lib/host-provisioner.mjs").HostProvisioner}
 */
export function createSynologyDockerHostProvisioner(ctx) {
  const { execOpts, opts: provOpts = {} } = ctx;
  const dryRun = provOpts.dryRun === true;
  const { target } = execOpts;

  return {
    backendId: "synology-docker",

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     * @param {import("../../../lib/host-provisioner.mjs").ContainerCreateSpec} spec
     */
    async createContainer(log, spec) {
      try {
        const ensured = await ensureSynologyDocker(execOpts, {
          log: (s) => log.info(s),
          dryRun,
        });
        if (!ensured.ok) {
          return { ok: false, message: ensured.message ?? "docker ensure failed" };
        }

        const p = /** @type {Record<string, unknown>} */ (spec.parameters ?? {});

        if (typeof p.compose_dir === "string" && p.compose_dir.trim()) {
          const composeYaml =
            typeof p.compose_yaml === "string" ? p.compose_yaml : undefined;
          const envContent =
            typeof p.env_content === "string" ? p.env_content : undefined;
          const result = await deployComposeStack(
            execOpts,
            {
              dir: p.compose_dir.trim(),
              composeYaml,
              envContent,
              pull: p.pull !== false && p.pull !== 0,
            },
            (s) => log.info(s),
            { ensureDocker: false, dryRun },
          );
          return {
            ok: result.ok,
            message: result.message ?? (result.ok ? `Compose stack at ${result.dir}` : "compose deploy failed"),
            details: { ...result, host: target.host },
          };
        }

        const name =
          (typeof p.container_name === "string" && p.container_name.trim()) ||
          spec.name.replace(/[^a-zA-Z0-9_.-]+/g, "-").toLowerCase() ||
          "container";
        const image =
          (typeof p.docker_image === "string" && p.docker_image.trim()) || "alpine:latest";
        const publish =
          typeof p.publish === "string" && p.publish.trim()
            ? p.publish.trim()
            : typeof p.host_port === "number" && Number.isFinite(p.host_port)
              ? `${Math.trunc(p.host_port)}:80`
              : "";
        const volume =
          typeof p.volume === "string" && p.volume.trim() ? p.volume.trim() : "";

        if (dryRun) {
          log.info(`dry-run: would docker run ${image} as ${name} on ${target.host}`);
          return {
            ok: true,
            message: `dry-run: docker run ${name}`,
            details: { container: name, host: target.host, skipped: true },
          };
        }

        log.info(`docker inspect ${JSON.stringify(name)} on ${target.host} …`);
        const ins = synologyRemoteExec(execOpts, `docker inspect --type=container ${JSON.stringify(name)}`);
        if (ins.status === 0) {
          log.info("Container already exists; skipping docker run.");
          return {
            ok: true,
            message: `Docker container ${name} already present on ${target.host}`,
            details: { container: name, host: target.host, skipped: true },
          };
        }

        const runArgs = [
          "docker",
          "run",
          "-d",
          "--restart",
          "unless-stopped",
          "--name",
          name,
        ];
        if (publish) runArgs.push("-p", publish);
        if (volume) runArgs.push("-v", volume);
        runArgs.push(image);

        log.info(`docker run ${image} as ${name}${publish ? ` (-p ${publish})` : ""}`);
        const run = synologyRemoteExec(execOpts, runArgs.join(" "));
        if (run.status !== 0) {
          const errText = `${run.stderr ?? ""}${run.stdout ?? ""}`.trim() || "docker run failed";
          log.error(errText);
          return { ok: false, message: errText };
        }
        log.info("docker run completed.");
        return {
          ok: true,
          message: `Started Docker container ${name} on ${target.host}`,
          details: { container: name, host: target.host, publish, volume, image },
        };
      } catch (e) {
        const msg = /** @type {Error} */ (e).message || String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     * @param {import("../../../lib/host-provisioner.mjs").ContainerCreateSpec} spec
     * @param {{ removeVolume?: boolean }} [destroyOpts]
     */
    async destroyContainer(log, spec, destroyOpts = {}) {
      try {
        const p = /** @type {Record<string, unknown>} */ (spec.parameters ?? {});
        const composeDir =
          typeof p.compose_dir === "string" && p.compose_dir.trim() ? p.compose_dir.trim() : "";

        if (composeDir) {
          const result = await teardownComposeStack(
            execOpts,
            { dir: composeDir, removeVolumes: destroyOpts.removeVolume === true },
            (s) => log.info(s),
            { dryRun },
          );
          return {
            ok: result.ok,
            message: result.message ?? (result.ok ? `Compose stack removed at ${composeDir}` : "compose teardown failed"),
            details: { ...result, host: target.host },
          };
        }

        const name =
          (typeof p.container_name === "string" && p.container_name.trim()) ||
          spec.name.replace(/[^a-zA-Z0-9_.-]+/g, "-").toLowerCase() ||
          "container";
        const volumeName =
          typeof p.volume === "string" && p.volume.trim()
            ? p.volume.split(":")[0].trim()
            : `${name}-data`;

        if (dryRun) {
          log.info(`dry-run: would remove container ${name} on ${target.host}`);
          return {
            ok: true,
            message: `dry-run: docker rm ${name}`,
            details: { container: name, host: target.host, skipped: true },
          };
        }

        log.info(`docker inspect ${JSON.stringify(name)} on ${target.host} …`);
        const ins = synologyRemoteExec(execOpts, `docker inspect --type=container ${JSON.stringify(name)}`);
        if (ins.status !== 0) {
          log.info(`Container ${name} not present on ${target.host}; nothing to remove.`);
          return {
            ok: true,
            message: `Docker container ${name} not found on ${target.host}`,
            details: { container: name, host: target.host, skipped: true },
          };
        }

        log.info(`docker rm -f ${name}`);
        const rm = synologyRemoteExec(execOpts, `docker rm -f ${JSON.stringify(name)}`);
        if (rm.status !== 0) {
          const errText = `${rm.stderr ?? ""}${rm.stdout ?? ""}`.trim() || "docker rm failed";
          log.error(errText);
          return { ok: false, message: errText };
        }

        if (destroyOpts.removeVolume) {
          log.info(`docker volume rm ${volumeName}`);
          const vol = synologyRemoteExec(
            execOpts,
            `docker volume rm ${JSON.stringify(volumeName)} 2>/dev/null || true`,
          );
          if (vol.status !== 0) {
            log.warn(`Volume remove may have failed for ${volumeName}`);
          }
        }

        log.info(`docker destroy completed for ${name}.`);
        return {
          ok: true,
          message: `Removed Docker container ${name} on ${target.host}`,
          details: {
            container: name,
            host: target.host,
            volume_removed: Boolean(destroyOpts.removeVolume),
          },
        };
      } catch (e) {
        const msg = /** @type {Error} */ (e).message || String(e);
        log.error(msg);
        return { ok: false, message: msg };
      }
    },

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     */
    async createVm(log) {
      const r = vmNotSupportedResult("synology-docker");
      log.warn(r.message ?? "VM not supported");
      return r;
    },
  };
}
