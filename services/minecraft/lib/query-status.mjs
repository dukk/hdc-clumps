import { createConnection } from "node:net";
import { stderr as errout } from "node:process";

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export function tcpConnect(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const t = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(t);
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").resolveMinecraftDeployments>[number]} deployment
 */
export async function queryMinecraftLive(deployment) {
  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim()
      ? sshCfg.host.trim()
      : ip.split("/")[0];
  const javaPort = deployment.minecraft?.javaPort || 25565;
  const bedrockPort = deployment.minecraft?.bedrockPort || 19132;
  const bluemap = deployment.minecraft?.bluemap === true;
  const bluemapPort = Number(deployment.minecraft?.bluemapWebPort) || 8100;

  /** @type {Record<string, unknown>} */
  const entry = {
    system_id: deployment.systemId,
    ssh_host: sshHost || null,
    java_port: javaPort,
    bedrock_port: bedrockPort,
    bluemap,
    bluemap_web_port: bluemap ? bluemapPort : null,
  };

  if (sshHost) {
    errout.write(`[hdc] minecraft query: live checks via ssh ${sshHost} …\n`);
    const sshUser = resolveGuestSshUser(sshCfg.user);
    const exec = createConfigureExec("ssh", { user: sshUser, host: sshHost });
    const st = exec.run("systemctl is-active minecraft 2>/dev/null || true", { capture: true });
    entry.systemd_active = (st.stdout ?? "").trim();
    const ver = exec.run("cat /opt/minecraft/.paper-version 2>/dev/null || true", { capture: true });
    const paperVer = (ver.stdout ?? "").trim();
    if (paperVer) entry.paper_version_file = paperVer;
    const portRe = bluemap
      ? `:${javaPort}$|:${bedrockPort}$|:${bluemapPort}$`
      : `:${javaPort}$|:${bedrockPort}$`;
    const listen = exec.run(
      `ss -lntu 2>/dev/null | awk '$1 ~ /tcp|udp/ && $5 ~ /${portRe}/ {print}' || true`,
      { capture: true },
    );
    entry.listen_preview = (listen.stdout ?? "").trim() || null;
    const plugins = exec.run(
      "ls -1 /opt/minecraft/plugins/*.jar 2>/dev/null | xargs -n1 basename || true",
      { capture: true },
    );
    const pluginList = (plugins.stdout ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (pluginList.length) entry.plugin_jars = pluginList;
  }

  if (sshHost) {
    entry.java_tcp_ok = await tcpConnect(sshHost, javaPort);
    if (bluemap) {
      errout.write(`[hdc] minecraft query: probing BlueMap tcp ${sshHost}:${bluemapPort} …\n`);
      entry.bluemap_tcp_ok = await tcpConnect(sshHost, bluemapPort);
    }
  } else {
    entry.java_tcp_ok = null;
  }

  return entry;
}
