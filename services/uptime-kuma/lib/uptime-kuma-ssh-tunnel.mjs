import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { devNull, platform } from "node:os";

const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  `UserKnownHostsFile=${devNull}`,
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

/**
 * @returns {string}
 */
export function resolveSshCommand() {
  return platform() === "win32" ? "ssh.exe" : "ssh";
}

/**
 * @param {string} apiUrl
 */
export function parseLocalApiPort(apiUrl) {
  try {
    const u = new URL(apiUrl);
    if (!/^127\.0\.0\.1|localhost$/i.test(u.hostname)) return null;
    const port = u.port ? Number(u.port) : 80;
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} apiUrl
 * @param {number} localPort
 */
export function rewriteLocalApiPort(apiUrl, localPort) {
  try {
    const u = new URL(apiUrl);
    if (!/^127\.0\.0\.1|localhost$/i.test(u.hostname)) return apiUrl.replace(/\/$/, "");
    u.port = String(localPort);
    return u.toString().replace(/\/$/, "");
  } catch {
    return apiUrl.replace(/\/$/, "");
  }
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 */
export function waitForLocalTcpPort(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    const attempt = () => {
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`local port ${port} did not accept connections within ${timeoutMs}ms`));
        return;
      }
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        if (timer) clearTimeout(timer);
        resolve(undefined);
      });
      socket.once("error", () => {
        socket.destroy();
        timer = setTimeout(attempt, 250);
      });
    };

    attempt();
  });
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 */
export function isLocalTcpPortOpen(port, timeoutMs = 500) {
  return waitForLocalTcpPort(port, timeoutMs).then(
    () => true,
    () => false,
  );
}

/**
 * @param {number} preferredPort
 */
export async function resolveTunnelLocalPort(preferredPort) {
  if (!(await isLocalTcpPortOpen(preferredPort))) {
    return preferredPort;
  }
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port =
        addr && typeof addr === "object" && typeof addr.port === "number" ? addr.port : preferredPort;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.host
 * @param {number} opts.localPort
 * @param {number} opts.remotePort
 * @param {(line: string) => void} [opts.log]
 */
export function startUptimeKumaSshTunnel(opts) {
  const { user, host, localPort, remotePort } = opts;
  const log = opts.log ?? (() => {});
  const args = [
    ...SSH_OPTS,
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    `${user}@${host}`,
  ];
  log(`SSH tunnel -L ${localPort}:127.0.0.1:${remotePort} ${user}@${host}`);
  const child = spawn(resolveSshCommand(), args, { stdio: ["ignore", "ignore", "pipe"] });
  return child;
}

/**
 * @param {object} opts
 * @param {string} opts.apiUrl
 * @param {Record<string, unknown>} configure
 * @param {(line: string) => void} [opts.log]
 * @param {(ctx: { apiUrl: string }) => Promise<unknown>} fn
 */
export async function withUptimeKumaSshTunnelIfNeeded(opts, fn) {
  const configure = opts.configure ?? {};
  const ssh = configure.ssh && typeof configure.ssh === "object" ? configure.ssh : {};
  const host = typeof ssh.host === "string" ? ssh.host.trim() : "";
  const user = typeof ssh.user === "string" && ssh.user.trim() ? ssh.user.trim() : "ubuntu";
  const remotePort = parseLocalApiPort(opts.apiUrl);
  const needsTunnel = Boolean(host && remotePort != null);

  if (!needsTunnel) {
    return fn({ apiUrl: opts.apiUrl.replace(/\/$/, "") });
  }

  const localPort = await resolveTunnelLocalPort(remotePort);
  const effectiveApiUrl = rewriteLocalApiPort(opts.apiUrl, localPort);
  const log = opts.log ?? (() => {});
  const child = startUptimeKumaSshTunnel({
    user,
    host,
    localPort,
    remotePort,
    log,
  });

  /** @type {string[]} */
  const stderrLines = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SSH tunnel to ${user}@${host} did not become ready`));
    }, 20000);

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) stderrLines.push(trimmed);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code != null && code !== 0) {
        clearTimeout(timer);
        const detail = stderrLines.length ? `: ${stderrLines.join("; ")}` : "";
        reject(new Error(`SSH tunnel exited with code ${code}${detail}`));
      }
    });

    waitForLocalTcpPort(localPort, 20000)
      .then(() => {
        clearTimeout(timer);
        resolve(undefined);
      })
      .catch((err) => {
        clearTimeout(timer);
        const detail = stderrLines.length ? ` (${stderrLines.join("; ")})` : "";
        reject(new Error(`${err instanceof Error ? err.message : String(err)}${detail}`));
      });
  });

  try {
    return await fn({ apiUrl: effectiveApiUrl });
  } finally {
    child.kill("SIGTERM");
  }
}
