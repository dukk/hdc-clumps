import { spawnSync } from "node:child_process";

import { parseHomepageServicesYaml } from "./homepage-services-parse.mjs";

/**
 * @typedef {{ group: string; name: string; kind: "siteMonitor" | "ping"; target: string }} HomepageMonitorTarget
 * @typedef {{
 *   group: string;
 *   name: string;
 *   kind: "siteMonitor" | "ping";
 *   target: string;
 *   ok: boolean;
 *   error?: string | null;
 *   http_code?: number | null;
 *   latency_ms?: number | null;
 * }} HomepageMonitorProbeResult
 */

/**
 * @param {ReturnType<typeof parseHomepageServicesYaml>} groups
 * @returns {HomepageMonitorTarget[]}
 */
export function enumerateHomepageMonitorTargets(groups) {
  /** @type {HomepageMonitorTarget[]} */
  const out = [];
  for (const g of groups) {
    for (const s of g.services) {
      const siteMonitor =
        typeof s.siteMonitor === "string" && s.siteMonitor.trim() ? s.siteMonitor.trim() : "";
      const ping = typeof s.ping === "string" && s.ping.trim() ? s.ping.trim() : "";
      if (siteMonitor) {
        out.push({ group: g.name, name: s.name, kind: "siteMonitor", target: siteMonitor });
      }
      if (ping) {
        out.push({ group: g.name, name: s.name, kind: "ping", target: ping });
      }
    }
  }
  return out;
}

/**
 * @param {string} servicesYaml
 */
export function parseHomepageMonitorTargetsFromYaml(servicesYaml) {
  return enumerateHomepageMonitorTargets(parseHomepageServicesYaml(servicesYaml));
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function probeSiteMonitorUrl(url, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "hdc-homepage-sitemonitor-probe/1" },
    });
    const latency_ms = Date.now() - started;
    const ok = resp.status >= 200 && resp.status < 400;
    return {
      ok,
      http_code: resp.status,
      latency_ms,
      error: ok ? null : `HTTP ${resp.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      http_code: null,
      latency_ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @param {string} host
 * @param {number} timeoutSec
 */
export function probePingHost(host, timeoutSec = 3) {
  const target = String(host ?? "").trim();
  if (!target) {
    return { ok: false, error: "empty ping target", latency_ms: null };
  }
  const started = Date.now();
  const args =
    process.platform === "win32"
      ? ["-n", "1", "-w", String(Math.max(1000, timeoutSec * 1000)), target]
      : ["-c", "1", "-W", String(timeoutSec), target];
  const r = spawnSync("ping", args, { encoding: "utf8", timeout: (timeoutSec + 2) * 1000 });
  const latency_ms = Date.now() - started;
  const ok = r.status === 0;
  const detail = (r.stderr || r.stdout || "").trim();
  return {
    ok,
    latency_ms,
    error: ok ? null : detail.slice(0, 200) || `ping exit ${r.status ?? "unknown"}`,
  };
}

/**
 * @param {HomepageMonitorTarget} target
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function probeHomepageMonitorTarget(target, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  if (target.kind === "ping") {
    const ping = probePingHost(target.target, Math.ceil(timeoutMs / 1000));
    return {
      ...target,
      ok: ping.ok,
      error: ping.error,
      latency_ms: ping.latency_ms,
    };
  }
  const http = await probeSiteMonitorUrl(target.target, timeoutMs);
  return {
    ...target,
    ok: http.ok,
    error: http.error,
    http_code: http.http_code,
    latency_ms: http.latency_ms,
  };
}

/**
 * @param {HomepageMonitorTarget[]} targets
 * @param {{ timeoutMs?: number; concurrency?: number; log?: (line: string) => void }} [opts]
 */
export async function probeHomepageMonitorTargets(targets, opts = {}) {
  const log = opts.log ?? (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  /** @type {HomepageMonitorProbeResult[]} */
  const results = [];

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (t) => {
        log(`probe ${t.group}/${t.name} (${t.kind}) ${t.target}`);
        return probeHomepageMonitorTarget(t, opts);
      }),
    );
    results.push(...batchResults);
  }

  const failing = results.filter((r) => !r.ok);
  return {
    target_count: targets.length,
    failing_count: failing.length,
    results,
    failing,
  };
}
