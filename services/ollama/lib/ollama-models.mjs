import { resolveGuestSshUser } from "hdc/package/guest-ssh-resolve.mjs";
import { stderr as errout } from "node:process";

import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { resolveUbuntuBootstrapSsh } from "../../../infrastructure/ubuntu/lib/ubuntu-ssh-resolve.mjs";
import { flagGet } from "hdc/package/parse-argv-flags.mjs";
import { resolvePveSshForHost } from "./ollama-install.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} ollamaBlock
 * @returns {string[]}
 */
export function normalizeModelNames(ollamaBlock) {
  if (!isObject(ollamaBlock)) return [];
  const raw = ollamaBlock.models;
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
export function diffOllamaModels(desired, live) {
  const desiredSet = new Set(desired);
  const liveSet = new Set(live);
  const pull = desired.filter((n) => !liveSet.has(n));
  const remove = live.filter((n) => !desiredSet.has(n));
  return { pull, remove };
}

/**
 * @param {Record<string, unknown>} deployment Resolved deployment from finalizeDeployment
 * @param {string} proxmoxRoot Absolute path to proxmox clump root
 * @param {string} ubuntuRoot Absolute path to ubuntu clump root
 * @param {NodeJS.ProcessEnv} [processEnv]
 */
export function createOllamaExec(deployment, proxmoxRoot, ubuntuRoot, processEnv = process.env) {
  const mode = deployment.mode;
  if (mode === "ubuntu-docker") {
    const ub = isObject(deployment.ubuntu) ? deployment.ubuntu : {};
    const bid = typeof ub.bootstrap_host_id === "string" ? ub.bootstrap_host_id.trim() : "";
    if (!bid) throw new Error("ubuntu-docker: missing bootstrap_host_id");
    const ssh = resolveUbuntuBootstrapSsh(ubuntuRoot, bid, processEnv);
    if (!ssh) throw new Error(`ubuntu-docker: SSH not resolved for ${bid}`);
    const dk = isObject(ub.docker) ? ub.docker : {};
    const container =
      typeof dk.container_name === "string" && dk.container_name.trim()
        ? dk.container_name.trim()
        : "ollama";
    const base = createConfigureExec("ssh", { user: ssh.user, host: ssh.host });
    return /** @type {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} */ ({
      label: `docker exec ${container} on ${ssh.user}@${ssh.host}`,
      run: (inner, opts) => {
        const wrapped = `docker exec ${container} bash -lc ${shellQuote(inner)}`;
        return base.run(wrapped, opts);
      },
    });
  }

  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  const hostId = typeof px.host_id === "string" ? px.host_id.trim() : "";
  if (!hostId) throw new Error("missing proxmox.host_id");

  if (mode === "proxmox-lxc") {
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const vmid = typeof lxc.vmid === "number" ? lxc.vmid : Number(lxc.vmid);
    if (!Number.isFinite(vmid) || vmid <= 0) throw new Error("invalid proxmox.lxc.vmid");
    const pveSsh = resolvePveSshForHost(proxmoxRoot, hostId);
    return createConfigureExec("pct", {
      user: pveSsh.user,
      host: pveSsh.host,
      vmid,
      pveHost: pveSsh.host,
    });
  }

  if (mode === "proxmox-qemu") {
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
    return createConfigureExec("ssh", { user: sshUser, host: sshHost });
  }

  throw new Error(`createOllamaExec: unsupported mode ${JSON.stringify(mode)}`);
}

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @returns {Promise<{ ok: boolean; models: string[]; error?: string }>}
 */
export async function listOllamaModels(exec) {
  const listCmd = "ollama list 2>/dev/null || true";
  const r = exec.run(listCmd, { capture: true });
  if (r.status === 0) {
    return { ok: true, models: parseOllamaListOutput(r.stdout) };
  }

  const apiCmd =
    "curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); print('\\n'.join(m.get('name','') for m in d.get('models',[])))\"" +
    " 2>/dev/null || curl -sf http://127.0.0.1:11434/api/tags";
  const api = exec.run(apiCmd, { capture: true });
  if (api.status !== 0) {
    const detail = `${api.stderr}${api.stdout}`.trim() || `exit ${api.status}`;
    return { ok: false, models: [], error: detail };
  }
  const tags = parseOllamaTagsResponse(api.stdout);
  if (tags) {
    return { ok: true, models: tags.models };
  }
  const fromList = parseOllamaListOutput(api.stdout);
  if (fromList.length > 0) {
    return { ok: true, models: fromList };
  }
  return { ok: false, models: [], error: "no models parsed" };
}

/**
 * @param {string} stdout
 */
export function parseOllamaListOutput(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  /** @type {string[]} */
  const names = [];
  for (const line of lines) {
    if (/^NAME\b/i.test(line)) continue;
    const col = line.split(/\s+/)[0];
    if (col && col !== "NAME") names.push(col);
  }
  return names;
}

/**
 * Parse Ollama /api/tags JSON. Returns null when stdout is not valid tags JSON.
 * @param {string} stdout
 * @returns {{ models: string[] } | null}
 */
export function parseOllamaTagsResponse(stdout) {
  try {
    const data = JSON.parse(String(stdout ?? "").trim());
    if (!isObject(data) || !Array.isArray(data.models)) return null;
    /** @type {string[]} */
    const names = [];
    for (const m of data.models) {
      if (isObject(m) && typeof m.name === "string" && m.name.trim()) {
        names.push(m.name.trim());
      }
    }
    return { models: names };
  } catch {
    return null;
  }
}

/**
 * @param {string} stdout
 */
export function parseOllamaTagsJson(stdout) {
  const tags = parseOllamaTagsResponse(stdout);
  return tags ? tags.models : [];
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} name
 */
export function pullOllamaModel(exec, name) {
  const safe = name.replace(/'/g, `'\\''`);
  errout.write(`[hdc] ollama models: pulling ${JSON.stringify(name)} via ${exec.label} …\n`);
  const r = exec.run(`ollama pull '${safe}'`, { capture: false });
  return { ok: r.status === 0, status: r.status };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} name
 */
export function removeOllamaModel(exec, name) {
  const safe = name.replace(/'/g, `'\\''`);
  errout.write(`[hdc] ollama models: removing ${JSON.stringify(name)} via ${exec.label} …\n`);
  const r = exec.run(`ollama rm '${safe}'`, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    return { ok: false, error: detail };
  }
  return { ok: true };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string[]} desired
 * @param {Record<string, string>} flags
 * @param {{ prune?: boolean }} [opts]
 */
export async function syncOllamaModels(exec, desired, flags, opts = {}) {
  const dryRun = flagGet(flags, "dry-run", "dry_run") !== undefined;
  const prune = opts.prune === true || flagGet(flags, "prune") !== undefined;

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
    };
  }

  const listed = await listOllamaModels(exec);
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

  const { pull, remove } = diffOllamaModels(desired, listed.models);
  const toRemove = prune ? remove : [];

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      desired,
      live: listed.models,
      would_pull: pull,
      would_remove: toRemove,
      pulled: [],
      removed: [],
    };
  }

  /** @type {string[]} */
  const pulled = [];
  /** @type {string[]} */
  const removed = [];
  /** @type {{ name: string; error: string }[]} */
  const errors = [];

  for (const name of pull) {
    const r = pullOllamaModel(exec, name);
    if (r.ok) pulled.push(name);
    else errors.push({ name, error: `pull failed (exit ${r.status})` });
  }

  for (const name of toRemove) {
    const r = removeOllamaModel(exec, name);
    if (r.ok) removed.push(name);
    else errors.push({ name, error: r.error ?? "rm failed" });
  }

  return {
    ok: errors.length === 0,
    desired,
    live: listed.models,
    pulled,
    removed,
    would_pull: pull,
    would_remove: toRemove,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * Resolve HTTP API base for query --live (no trailing slash).
 * @param {Record<string, unknown>} deployment Raw merged deployment object
 */
export function resolveOllamaApiBase(deployment) {
  const mode = typeof deployment.mode === "string" ? deployment.mode.trim() : "";
  const configure = isObject(deployment.configure) ? deployment.configure : {};
  const sshCfg = isObject(configure.ssh) ? configure.ssh : {};
  if (typeof sshCfg.host === "string" && sshCfg.host.trim()) {
    const host = sshCfg.host.trim().split("/")[0];
    return apiBaseFromHost(host, deployment);
  }
  const px = isObject(deployment.proxmox) ? deployment.proxmox : {};
  if (mode === "proxmox-qemu") {
    const q = isObject(px.qemu) ? px.qemu : {};
    if (typeof q.ip === "string" && q.ip.trim()) {
      return apiBaseFromHost(q.ip.split("/")[0], deployment);
    }
  }
  if (mode === "proxmox-lxc") {
    const lxc = isObject(px.lxc) ? px.lxc : {};
    const ipConfig = typeof lxc.ip_config === "string" ? lxc.ip_config.trim() : "";
    if (ipConfig) {
      const ip = ipConfig.split(",")[0].split("/")[0].trim();
      if (ip && ip !== "dhcp") return apiBaseFromHost(ip, deployment);
    }
  }
  const ub = isObject(deployment.ubuntu) ? deployment.ubuntu : {};
  if (mode === "ubuntu-docker" && isObject(ub.docker)) {
    const port =
      typeof ub.docker.host_port === "number" && ub.docker.host_port > 0
        ? ub.docker.host_port
        : 11434;
    const bid = typeof ub.bootstrap_host_id === "string" ? ub.bootstrap_host_id.trim() : "";
    if (bid) {
      return { host: null, port, bootstrap_host_id: bid };
    }
  }
  return null;
}

/**
 * @param {string} host
 * @param {Record<string, unknown>} deployment
 */
function apiBaseFromHost(host, deployment) {
  const ub = isObject(deployment.ubuntu) ? deployment.ubuntu : {};
  const dk = isObject(ub.docker) ? ub.docker : {};
  const port =
    typeof dk.host_port === "number" && dk.host_port > 0 ? dk.host_port : 11434;
  return `http://${host}:${port}`;
}

/**
 * @param {string} apiBase
 * @returns {Promise<{ ok: boolean; models: string[]; error?: string }>}
 */
export async function fetchOllamaModelsHttp(apiBase) {
  const url = `${apiBase.replace(/\/$/, "")}/api/tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const models = parseOllamaTagsJson(text);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: String(/** @type {Error} */ (e).message || e) };
  }
}
