import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Merge generated fleet/sidecar A2A entries into hdc-private litellm config.
 * Preserves manual workstation augmentor entries (upsert fleet/sidecar by name).
 *
 * @param {object} opts
 * @param {string} opts.privateRoot
 * @param {unknown[]} opts.generatedEntries
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.dryRun]
 */
export function mergeLitellmA2aAgents(opts) {
  const privateRoot = String(opts.privateRoot ?? "").trim();
  if (!privateRoot) {
    return { ok: false, message: "privateRoot required" };
  }
  const configPath = join(privateRoot, "clumps", "services", "litellm", "config.json");
  if (!existsSync(configPath)) {
    return { ok: false, message: `litellm config not found: ${configPath}` };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return { ok: false, message: `invalid litellm config JSON: ${/** @type {Error} */ (e).message}` };
  }

  const defaults = raw.defaults && typeof raw.defaults === "object" ? raw.defaults : raw;
  const litellm =
    defaults.litellm && typeof defaults.litellm === "object"
      ? /** @type {Record<string, unknown>} */ (defaults.litellm)
      : {};
  const existing = Array.isArray(litellm.a2a_agents) ? [...litellm.a2a_agents] : [];

  const generatedNames = new Set(
    opts.generatedEntries
      .map((e) => (e && typeof e === "object" ? String(/** @type {Record<string, unknown>} */ (e).name ?? "") : ""))
      .filter(Boolean),
  );

  const manual = existing.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const name = String(/** @type {Record<string, unknown>} */ (entry).name ?? "").trim();
    if (!name) return false;
    if (generatedNames.has(name)) return false;
    const kind = String(/** @type {Record<string, unknown>} */ (entry).kind ?? "").trim();
    if (kind === "fleet") return false;
    if (name.startsWith("hdc-")) return false;
    return true;
  });

  const merged = [...opts.generatedEntries, ...manual];
  litellm.a2a_agents = merged;
  if (raw.defaults && typeof raw.defaults === "object") {
    /** @type {Record<string, unknown>} */ (raw.defaults).litellm = litellm;
  } else {
    raw.litellm = litellm;
  }

  if (!opts.dryRun) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }

  opts.log?.(
    `litellm a2a_agents: ${merged.length} entries (${opts.generatedEntries.length} generated, ${manual.length} manual preserved)`,
  );

  return {
    ok: true,
    path: configPath,
    count: merged.length,
    generated: opts.generatedEntries.length,
    manual_preserved: manual.length,
    dry_run: opts.dryRun === true,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.hdcRoot
 * @param {string} opts.privateRoot
 * @param {string} opts.guestIp
 * @param {Record<string, unknown>} opts.hdcAgents
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.skipLitellmMaintain]
 */
export async function registerFleetA2aOnLitellm(opts) {
  const { litellmA2aAgentEntries } = await import("./hdc-agents-render.mjs");
  const generated = litellmA2aAgentEntries(opts.guestIp, opts.hdcAgents);
  const mergeResult = mergeLitellmA2aAgents({
    privateRoot: opts.privateRoot,
    generatedEntries: generated,
    log: opts.log,
    dryRun: opts.dryRun,
  });
  if (!mergeResult.ok) return mergeResult;

  if (opts.dryRun || opts.skipLitellmMaintain) {
    return { ...mergeResult, litellm_maintain: "skipped" };
  }

  const { spawnSync } = await import("node:child_process");
  const cli = join(opts.hdcRoot, "apps", "hdc-cli", "cli.mjs");
  if (!existsSync(cli)) {
    return { ...mergeResult, litellm_maintain: "skipped", litellm_maintain_reason: "hdc cli missing" };
  }

  opts.log?.("running litellm maintain to apply a2a_agents …");
  const r = spawnSync(process.execPath, [cli, "run", "service", "litellm", "maintain", "--"], {
    cwd: opts.hdcRoot,
    encoding: "utf8",
    timeout: 600_000,
    env: process.env,
  });

  return {
    ...mergeResult,
    litellm_maintain: r.status === 0 ? "ok" : "failed",
    litellm_maintain_status: r.status,
    litellm_maintain_stderr: String(r.stderr ?? "").slice(0, 1000),
  };
}
