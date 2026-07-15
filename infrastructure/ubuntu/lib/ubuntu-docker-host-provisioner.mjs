import { spawnSync } from "node:child_process";

import { vmNotSupportedResult } from "hdc/package/host-provisioner.mjs";

/**
 * @param {object} ctx
 * @param {string} ctx.sshUser
 * @param {string} ctx.sshHost
 * @param {string[]} [ctx.sshExtraArgs] Prefix args before user@host (e.g. `-i`, `key.pem`)
 * @returns {import("../../../lib/host-provisioner.mjs").HostProvisioner}
 */
export function createUbuntuDockerHostProvisioner(ctx) {
  const { sshUser, sshHost, sshExtraArgs = [] } = ctx;
  const sshPrefix = [...sshExtraArgs, "-o", "BatchMode=yes"];
  const dest = `${sshUser}@${sshHost}`;

  /**
   * @param {string[]} remoteArgv
   */
  function ssh(remoteArgv) {
    return spawnSync("ssh", [...sshPrefix, dest, ...remoteArgv], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  return {
    backendId: "ubuntu-docker",

    /**
     * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
     * @param {import("../../../lib/host-provisioner.mjs").ContainerCreateSpec} spec
     */
    async createContainer(log, spec) {
      try {
        const p = /** @type {Record<string, unknown>} */ (spec.parameters ?? {});
        const name =
          (typeof p.container_name === "string" && p.container_name.trim()) ||
          spec.name.replace(/[^a-zA-Z0-9_.-]+/g, "-").toLowerCase() ||
          "ollama";
        const image =
          (typeof p.docker_image === "string" && p.docker_image.trim()) || "ollama/ollama:latest";
        const publish =
          typeof p.publish === "string" && p.publish.trim()
            ? p.publish.trim()
            : typeof p.host_port === "number" && Number.isFinite(p.host_port)
              ? `${Math.trunc(p.host_port)}:11434`
              : "11434:11434";
        const volume =
          typeof p.volume === "string" && p.volume.trim() ? p.volume.trim() : `${name}-data:/root/.ollama`;

        log.info(`docker inspect ${JSON.stringify(name)} on ${dest} …`);
        const ins = ssh(["docker", "inspect", "--type=container", name]);
        if ((ins.status ?? 1) === 0) {
          log.info("Container already exists; skipping docker run.");
          return {
            ok: true,
            message: `Docker container ${name} already present on ${sshHost}`,
            details: { container: name, host: sshHost, skipped: true },
          };
        }

        log.info(`docker run ${image} as ${name} (-p ${publish})`);
        const run = ssh([
          "docker",
          "run",
          "-d",
          "--restart",
          "unless-stopped",
          "--name",
          name,
          "-p",
          publish,
          "-v",
          volume,
          image,
        ]);
        if ((run.status ?? 1) !== 0) {
          const errText = `${run.stderr ?? ""}${run.stdout ?? ""}`.trim() || "ssh docker run failed";
          log.error(errText);
          return { ok: false, message: errText };
        }
        log.info("docker run completed.");
        return {
          ok: true,
          message: `Started Ollama Docker container ${name} on ${sshHost}`,
          details: { container: name, host: sshHost, publish, volume, image },
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
      const r = vmNotSupportedResult("ubuntu-docker");
      log.warn(r.message ?? "VM not supported");
      return r;
    },
  };
}
