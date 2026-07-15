import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { stderr as errout } from "node:process";

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolveLinuxUser } from "./lms-install.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} lmsBlock
 * @returns {string[]}
 */
export function normalizeModelNames(lmsBlock) {
  if (!isObject(lmsBlock)) return [];
  const raw = lmsBlock.models;
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const names = [];
  const seen = new Set();
  for (const item of raw) {
    let name = "";
    if (typeof item === "string") {
      name = item.trim();
    } else if (isObject(item) && typeof item.name === "string") {
      name = item.name.trim();
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * @param {string[]} desired
 * @param {string[]} live
 */
export function diffLmsModels(desired, live) {
  const desiredSet = new Set(desired);
  const liveSet = new Set(live);
  const pull = desired.filter((n) => !liveSet.has(n));
  const remove = live.filter((n) => !desiredSet.has(n));
  return { pull, remove };
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").resolveLmsDeployments>[number]} deployment
 */
export function createLmsExec(deployment) {
  const mode = deployment.mode;
  if (mode !== "proxmox-qemu") {
    throw new Error(`createLmsExec: unsupported mode ${JSON.stringify(mode)}`);
  }
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  const ip = typeof q.ip === "string" ? q.ip.trim() : "";
  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
  const sshUser = resolveGuestSshUser(sshCfg.user);
  const sshHost =
    typeof sshCfg.host === "string" && sshCfg.host.trim()
      ? sshCfg.host.trim()
      : ip
        ? ip.split("/")[0]
        : "";
  if (!sshHost) throw new Error("proxmox-qemu: configure.ssh.host or proxmox.qemu.ip required");

  const install = isObject(deployment.install) ? deployment.install : {};
  const linuxUser = resolveLinuxUser(install);
  const home = `/home/${linuxUser}`;
  const base = createConfigureExec("ssh", { user: sshUser, host: sshHost });

  return /** @type {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} */ ({
    label: `lms as ${linuxUser}@${sshHost}`,
    run: (inner, opts) => {
      const safe = inner.replace(/'/g, `'\\''`);
      const wrapped = `runuser -u ${linuxUser} -- env HOME=${home} bash -lc '${safe}'`;
      return base.run(wrapped, opts);
    },
  });
}

/**
 * @param {string} stdout
 */
export function parseLmsListOutput(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  /** @type {string[]} */
  const names = [];
  for (const line of lines) {
    if (/^(model|name|id)\b/i.test(line)) continue;
    const col = line.split(/\s+/)[0];
    if (col) names.push(col);
  }
  return names;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export async function listLmsModels(exec) {
  const r = exec.run("command -v lms >/dev/null && lms ls 2>/dev/null || true", { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, models: [], error: detail };
  }
  return { ok: true, models: parseLmsListOutput(r.stdout) };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} name
 */
export function pullLmsModel(exec, name) {
  const safe = name.replace(/'/g, `'\\''`);
  errout.write(`[hdc] lms models: downloading ${JSON.stringify(name)} via ${exec.label} …\n`);
  const r = exec.run(`lms get '${safe}'`, { capture: false });
  return { ok: r.status === 0, status: r.status };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string[]} desired
 * @param {Record<string, string>} flags
 * @param {{ prune?: boolean }} [opts]
 */
export async function syncLmsModels(exec, desired, flags, opts = {}) {
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  const prune = opts.prune === true || flagGet(flags, "prune") !== undefined;

  if (prune) {
    errout.write(
      "[hdc] lms models: --prune is not supported (LM Studio CLI has no stable model removal); skipping removals.\n",
    );
  }

  if (!desired.length) {
    return {
      ok: true,
      skipped: true,
      message: "no models configured",
      desired: [],
      live: [],
      pulled: [],
      removed: [],
      would_pull: [],
      would_remove: [],
      prune_ignored: prune || undefined,
    };
  }

  const listed = await listLmsModels(exec);
  if (!listed.ok) {
    const message = listed.error ?? "failed to list models";
    return {
      ok: false,
      message,
      error: message,
      desired,
      live: [],
      pulled: [],
      removed: [],
    };
  }

  const { pull } = diffLmsModels(desired, listed.models);

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      desired,
      live: listed.models,
      would_pull: pull,
      would_remove: [],
      pulled: [],
      removed: [],
      prune_ignored: prune || undefined,
    };
  }

  /** @type {string[]} */
  const pulled = [];
  /** @type {{ name: string; error: string }[]} */
  const errors = [];

  for (const name of pull) {
    const r = pullLmsModel(exec, name);
    if (r.ok) pulled.push(name);
    else errors.push({ name, error: `lms get failed (exit ${r.status})` });
  }

  return {
    ok: errors.length === 0,
    desired,
    live: listed.models,
    pulled,
    removed: [],
    would_pull: pull,
    would_remove: [],
    errors: errors.length ? errors : undefined,
    prune_ignored: prune || undefined,
  };
}

/**
 * @param {Record<string, unknown>} deployment Raw merged deployment object
 */
export function resolveLmsApiBase(deployment) {
  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
  const lmsBlock = isObject(deployment.lms) ? deployment.lms : {};
  const server = isObject(lmsBlock.server) ? lmsBlock.server : {};
  const port =
    typeof server.port === "number" && Number.isFinite(server.port)
      ? Math.trunc(server.port)
      : Number(server.port) || 1234;

  if (typeof sshCfg.host === "string" && sshCfg.host.trim()) {
    const host = sshCfg.host.trim().split("/")[0];
    return `http://${host}:${port}`;
  }
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const q = isObject(px.qemu) ? px.qemu : {};
  if (typeof q.ip === "string" && q.ip.trim()) {
    const host = q.ip.split("/")[0];
    return `http://${host}:${port}`;
  }
  return null;
}

/**
 * @param {string} apiBase
 */
export async function fetchLmsModelsHttp(apiBase) {
  const url = `${apiBase.replace(/\/$/, "")}/v1/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!isObject(data) || !Array.isArray(data.data)) {
      return { ok: true, models: [] };
    }
    /** @type {string[]} */
    const names = [];
    for (const m of data.data) {
      if (isObject(m) && typeof m.id === "string" && m.id.trim()) {
        names.push(m.id.trim());
      }
    }
    return { ok: true, models: names };
  } catch (e) {
    return { ok: false, models: [], error: String(/** @type {Error} */ (e).message || e) };
  }
}
