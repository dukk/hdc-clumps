/**
 * @param {string} host
 * @param {number} [port]
 * @param {number} [timeoutMs]
 */
export async function probeHomeAssistantHttp(host, port = 8123, timeoutMs = 5000) {
  const url = `http://${host}:${port}/`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ac.signal, redirect: "follow" });
    return {
      ok: res.ok || res.status === 302 || res.status === 401,
      status: res.status,
      url,
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      url,
      error: String(/** @type {Error} */ (e).message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll until Home Assistant UI responds or timeout.
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port]
 * @param {number} [opts.timeoutMs]
 * @param {(line: string) => void} [opts.log]
 */
export async function waitForHomeAssistantHttp(opts) {
  const host = opts.host.trim();
  const port = opts.port ?? 8123;
  const timeoutMs = opts.timeoutMs ?? 1_200_000;
  const intervalMs = 15_000;
  const log = opts.log ?? (() => {});
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    log(`Probing http://${host}:${port}/ …`);
    const probe = await probeHomeAssistantHttp(host, port, 8000);
    if (probe.ok) {
      return { ok: true, ...probe };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    ok: false,
    url: `http://${host}:${port}/`,
    error: `Home Assistant not reachable on ${host}:${port} within ${timeoutMs}ms — set static IP in HA UI if needed`,
  };
}
