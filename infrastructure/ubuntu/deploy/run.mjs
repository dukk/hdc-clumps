#!/usr/bin/env node
/**
 * Ubuntu infrastructure deploy — create Docker-based workload on a bootstrap host (SSH).
 *
 * Usage: `hdc run ubuntu deploy -- create-container --bootstrap-host-id <id> --name ollama …`
 * Host must appear in `clumps/infrastructure/ubuntu/config.json` → `bootstrap_hosts[]` with SSH access.
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stderr as errout, env } from "node:process";

import { provisionLogFromConsole } from "hdc/package/host-provisioner.mjs";
import { parseArgvFlags, flagGet, flagNumber } from "hdc/package/parse-argv-flags.mjs";
import { createUbuntuDockerHostProvisioner } from "hdc/package/ubuntu-docker-host-provisioner.mjs";
import { resolveUbuntuBootstrapSsh } from "hdc/package/ubuntu-ssh-resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verb = basename(here);
const clumpRoot = join(here, "..");

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const flags = parseArgvFlags(argv.slice(1));
  const log = provisionLogFromConsole(console);

  errout.write(`[hdc] ubuntu ${verb}: Docker container on SSH host (JSON on stdout).\n`);

  if (sub !== "create-container") {
    errout.write(
      `[hdc] ubuntu ${verb}: only create-container is supported (no VM path on this backend). Example: hdc run ubuntu deploy -- create-container --bootstrap-host-id example-ubuntu-host --name ollama\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ok: false, target: "ubuntu", verb: "deploy", message: "expected create-container" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const bid = flagGet(flags, "bootstrap-host-id", "host_id");
  if (!bid) {
    errout.write(`[hdc] ubuntu ${verb}: required --bootstrap-host-id <bootstrap_hosts[].id>\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target: "ubuntu", verb: "deploy", message: "missing bootstrap-host-id" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  errout.write(`[hdc] ubuntu ${verb}: resolving SSH from clumps/infrastructure/ubuntu/config.json …\n`);
  const ssh = resolveUbuntuBootstrapSsh(clumpRoot, bid, env);
  if (!ssh) {
    errout.write(`[hdc] ubuntu ${verb}: no SSH target for bootstrap host ${JSON.stringify(bid)}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, target: "ubuntu", verb: "deploy", message: "SSH target not found" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const name = flagGet(flags, "name", "service-name") ?? "ollama";
  const prov = createUbuntuDockerHostProvisioner({ sshUser: ssh.user, sshHost: ssh.host });

  const hostPortStr = flagGet(flags, "host-port", "host_port");
  const hostPort = flagNumber(hostPortStr, undefined);
  /** @type {Record<string, unknown>} */
  const parameters = {};
  if (flagGet(flags, "container-name", "container_name"))
    parameters.container_name = flagGet(flags, "container-name", "container_name");
  if (flagGet(flags, "docker-image", "docker_image")) parameters.docker_image = flagGet(flags, "docker-image", "docker_image");
  if (flagGet(flags, "publish", "port")) parameters.publish = flagGet(flags, "publish", "port");
  if (hostPort !== undefined) parameters.host_port = hostPort;
  if (flagGet(flags, "volume")) parameters.volume = flagGet(flags, "volume");

  const result = await prov.createContainer(log, { name, parameters });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.ok,
        target: "ubuntu",
        verb: "deploy",
        action: sub,
        bootstrap_host_id: bid,
        ssh_host: ssh.host,
        result,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((e) => {
  errout.write(`[hdc] ubuntu ${verb}: fatal: ${/** @type {Error} */ (e).stack || e}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: false, target: "ubuntu", verb: "deploy", message: String(/** @type {Error} */ (e).message || e) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
