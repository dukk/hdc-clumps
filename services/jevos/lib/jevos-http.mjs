/**
 * @param {string} baseUrl e.g. http://10.0.0.23:8017
 * @param {{ apiKey?: string | null; timeoutMs?: number; fetchImpl?: typeof fetch }} [opts]
 */
export async function probeJevos(baseUrl, opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  /** @type {Record<string, unknown>} */
  const out = { url: baseUrl };
  const t0 = Date.now();
  try {
    const h = await f(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    out.health_status = h.status;
    out.health_ms = Date.now() - t0;
  } catch (e) {
    out.health_status = null;
    out.health_error = String(/** @type {Error} */ (e).message || e);
    out.ok = false;
    return out;
  }
  const body = JSON.stringify({
    model: "jev-latest",
    state: "HDC health probe: the service answered its health check.",
    questions: { q: { type: "noul", instructions: "Is the service answering?" } },
  });
  try {
    const noAuth = await f(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    out.unauthenticated_status = noAuth.status;
  } catch (e) {
    out.unauthenticated_error = String(/** @type {Error} */ (e).message || e);
  }
  if (opts.apiKey) {
    const t1 = Date.now();
    try {
      const r = await f(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body,
        signal: AbortSignal.timeout(timeoutMs * 3),
      });
      out.authenticated_status = r.status;
      out.authenticated_ms = Date.now() - t1;
      if (r.ok) {
        const j = /** @type {any} */ (await r.json());
        out.sample_noul = j?.answers?.q?.noul ?? null;
      }
    } catch (e) {
      out.authenticated_error = String(/** @type {Error} */ (e).message || e);
    }
  }
  out.ok =
    out.health_status === 200 &&
    out.unauthenticated_status === 401 &&
    (!opts.apiKey || (out.authenticated_status === 200 && typeof out.sample_noul === "number"));
  return out;
}
