import { stderr as errout } from "node:process";

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import {
  composeDir,
  hostPort,
  resolveUpstreamUrl,
  resolveWebUrl,
} from "./audiobookshelf-render.mjs";

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {Record<string, unknown>} audiobookshelf
 * @param {Record<string, unknown>} install
 */
export async function queryAudiobookshelfOnHost(exec, audiobookshelf, install) {
  errout.write(`[hdc] audiobookshelf query: live checks via ${exec.label} …\n`);

  const dir = composeDir(install);
  const port = hostPort(audiobookshelf);

  const ps = exec.run(`cd '${dir.replace(/'/g, `'\\''`)}' && docker compose ps --format json 2>/dev/null || docker compose ps`);
  const dockerOk = ps.status === 0;

  const ipOut = exec.run("hostname -I | awk '{print $1}'");
  const guestIp = ipOut.status === 0 ? ipOut.stdout.trim().split(/\s+/)[0] || null : null;

  let httpOk = false;
  let httpStatus = null;
  if (guestIp) {
    const probe = exec.run(
      `curl -fsS -o /dev/null -w '%{http_code}' --connect-timeout 5 http://127.0.0.1:${port}/ 2>/dev/null || echo fail`,
    );
    const code = probe.stdout.trim();
    if (code !== "fail" && /^\d+$/.test(code)) {
      httpStatus = Number(code);
      httpOk = httpStatus >= 200 && httpStatus < 500;
    }
  }

  const versionOut = exec.run(
    `docker inspect audiobookshelf --format '{{.Config.Image}}' 2>/dev/null || true`,
  );
  const image = versionOut.status === 0 ? versionOut.stdout.trim() || null : null;

  return {
    docker_compose_ok: dockerOk,
    docker_ps: ps.stdout.trim() || null,
    image,
    guest_ip: guestIp,
    host_port: port,
    http_ok: httpOk,
    http_status: httpStatus,
    web_url: resolveWebUrl(audiobookshelf, guestIp),
    upstream_url: resolveUpstreamUrl(guestIp, audiobookshelf),
  };
}

/**
 * @param {Record<string, unknown>} configure
 * @param {Record<string, unknown>} audiobookshelf
 * @param {Record<string, unknown>} install
 */
export async function queryAudiobookshelfViaSsh(configure, audiobookshelf, install) {
  const ssh = configure && typeof configure === "object" && configure.ssh && typeof configure.ssh === "object"
    ? configure.ssh
    : {};
  const user = resolveGuestSshUser(ssh.user);
  const host = typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : "";
  if (!host) {
    throw new Error("configure.ssh.host required for live query");
  }
  const exec = createConfigureExec("ssh", { user, host });
  return queryAudiobookshelfOnHost(exec, audiobookshelf, install);
}
