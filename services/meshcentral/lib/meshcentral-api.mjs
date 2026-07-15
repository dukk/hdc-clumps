/**
 * MeshCentral control.ashx WebSocket client (same protocol as MeshCtrl).
 */
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

import { resolvePublicUrl } from "./meshcentral-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} meshcentral
 * @returns {string}
 */
export function resolveMeshcentralControlUrl(meshcentral) {
  const api = isObject(meshcentral.api) ? meshcentral.api : {};
  const explicit = typeof api.url === "string" ? api.url.trim() : "";
  if (explicit) {
    if (explicit.startsWith("wss://") || explicit.startsWith("ws://")) {
      return explicit.replace(/\/+$/, "");
    }
    if (explicit.startsWith("https://") || explicit.startsWith("http://")) {
      return publicUrlToControlWss(explicit);
    }
    throw new Error("meshcentral.api.url must be ws(s):// or http(s)://");
  }
  const publicUrl = resolvePublicUrl(meshcentral);
  if (!publicUrl) {
    throw new Error("meshcentral.public_url or meshcentral.api.url required for API access");
  }
  return publicUrlToControlWss(publicUrl);
}

/**
 * @param {string} publicUrl
 */
export function publicUrlToControlWss(publicUrl) {
  const u = new URL(publicUrl.replace(/\/+$/, ""));
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/control.ashx";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * @param {string} username
 * @param {string} password
 * @param {string} [token]
 */
export function meshAuthHeader(username, password, token) {
  let header = `${Buffer.from(username, "utf8").toString("base64")},${Buffer.from(password, "utf8").toString("base64")}`;
  if (token) {
    header += `,${Buffer.from(String(token), "utf8").toString("base64")}`;
  }
  return header;
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function apiUsernameVaultKey(meshcentral) {
  const api = isObject(meshcentral.api) ? meshcentral.api : {};
  return typeof api.username_vault_key === "string" && api.username_vault_key.trim()
    ? api.username_vault_key.trim()
    : "HDC_MESHCENTRAL_USERNAME";
}

/**
 * @param {Record<string, unknown>} meshcentral
 */
export function apiPasswordVaultKey(meshcentral) {
  const api = isObject(meshcentral.api) ? meshcentral.api : {};
  return typeof api.password_vault_key === "string" && api.password_vault_key.trim()
    ? api.password_vault_key.trim()
    : "HDC_MESHCENTRAL_PASSWORD";
}

/** @deprecated Use apiUsernameVaultKey / apiPasswordVaultKey */
export function apiUserVaultKey(meshcentral) {
  return apiUsernameVaultKey(meshcentral);
}

/**
 * @typedef {object} MeshcentralApiClient
 * @property {() => Promise<void>} close
 * @property {(action: string, payload?: Record<string, unknown>, opts?: { timeoutMs?: number; match?: (msg: Record<string, unknown>) => boolean }) => Promise<Record<string, unknown>>} request
 * @property {() => Promise<Record<string, unknown>[]>} listNodes
 * @property {(nodeIds: string[], action: string) => Promise<Record<string, unknown>>} power
 * @property {(nodeId: string, cmds: string, opts?: { powershell?: boolean; timeoutMs?: number }) => Promise<{ ok: boolean; output: string; raw: Record<string, unknown> }>} runCommand
 */

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} [opts.token]
 * @param {boolean} [opts.rejectUnauthorized]
 * @param {(line: string) => void} [opts.log]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @returns {Promise<MeshcentralApiClient>}
 */
export async function connectMeshcentralApi(opts) {
  const WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
  const log = opts.log ?? (() => {});
  const rejectUnauthorized = opts.rejectUnauthorized !== false;
  const responseId = `hdc-${randomBytes(4).toString("hex")}`;

  /** @type {((msg: Record<string, unknown>) => void)[]} */
  const waiters = [];

  log(`connecting to MeshCentral API ${opts.url.replace(/:[^:@/]+@/, ":***@")} …`);

  const ws = new WebSocketImpl(opts.url, {
    headers: {
      "x-meshauth": meshAuthHeader(opts.username, opts.password, opts.token),
    },
    rejectUnauthorized,
  });

  // Register message dispatch before open so we do not miss the initial serverinfo push.
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    for (const waiter of [...waiters]) {
      waiter(/** @type {Record<string, unknown>} */ (msg));
    }
  });

  const serverInfoReady = new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout>} */
    const timer = setTimeout(() => resolve(null), 3_000);
    /** @param {Record<string, unknown>} msg */
    const onServerInfo = (msg) => {
      if (msg.action !== "serverinfo") return;
      clearTimeout(timer);
      const idx = waiters.indexOf(onServerInfo);
      if (idx >= 0) waiters.splice(idx, 1);
      resolve(isObject(msg.serverinfo) ? msg.serverinfo : null);
    };
    waiters.push(onServerInfo);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("MeshCentral WebSocket connect timeout"));
    }, 30_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  log("MeshCentral WebSocket connected");
  const serverinfo = await serverInfoReady;
  if (serverinfo) {
    const uid = typeof serverinfo.userid === "string" ? serverinfo.userid : "";
    const uname = typeof serverinfo.username === "string" ? serverinfo.username : "";
    if (uid || uname) log(`authenticated as ${uname || uid}`);
  }

  /**
   * @param {string} action
   * @param {Record<string, unknown>} [payload]
   * @param {{ timeoutMs?: number; match?: (msg: Record<string, unknown>) => boolean }} [reqOpts]
   */
  function request(action, payload = {}, reqOpts = {}) {
    const timeoutMs = reqOpts.timeoutMs ?? 60_000;
    const match =
      reqOpts.match ??
      ((msg) => {
        if (msg.action !== action && msg.action !== "event") return false;
        if (msg.responseid != null && msg.responseid !== responseId) return false;
        return true;
      });

    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout>} */
      let timer;
      /** @param {Record<string, unknown>} msg */
      const onMsg = (msg) => {
        if (!match(msg)) return;
        cleanup();
        resolve(msg);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const idx = waiters.indexOf(onMsg);
        if (idx >= 0) waiters.splice(idx, 1);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`MeshCentral API timeout waiting for ${action}`));
      }, timeoutMs);
      waiters.push(onMsg);
      ws.send(JSON.stringify({ action, responseid: responseId, ...payload }));
    });
  }

  async function listNodes() {
    // MeshCtrl lists meshes alongside nodes; fire-and-forget is enough for side effects.
    void request("meshes", {}, {
      timeoutMs: 15_000,
      match: (m) => m.action === "meshes" && (m.responseid === responseId || m.meshes != null),
    }).catch(() => {});
    const msg = await request(
      "nodes",
      {},
      {
        timeoutMs: 60_000,
        // Require our responseid — unsolicited empty `{action:nodes,nodes:{}}` pushes otherwise win the race.
        match: (m) => m.action === "nodes" && m.responseid === responseId,
      },
    );
    if (typeof msg.result === "string" && msg.result && !/^ok$/i.test(msg.result)) {
      throw new Error(`MeshCentral nodes error: ${msg.result}`);
    }
    return flattenNodesPayload(msg.nodes);
  }

  /**
   * @param {string[]} nodeIds
   * @param {string} actionName wake|on|off|reset|sleep
   */
  async function power(nodeIds, actionName) {
    const a = String(actionName).toLowerCase();
    if (a === "wake" || a === "on") {
      return request(
        "wakedevices",
        { nodeids: nodeIds },
        {
          match: (m) =>
            (m.action === "wakedevices" || m.action === "poweraction") &&
            (m.responseid === responseId || m.result != null),
        },
      );
    }
    /** @type {Record<string, number>} */
    const types = { off: 2, reset: 3, sleep: 4 };
    const actiontype = types[a];
    if (actiontype == null) {
      throw new Error(`unknown power action ${JSON.stringify(actionName)} (use wake|on|off|reset|sleep)`);
    }
    return request(
      "poweraction",
      { nodeids: nodeIds, actiontype },
      {
        match: (m) =>
          m.action === "poweraction" && (m.responseid === responseId || m.result != null),
      },
    );
  }

  /**
   * @param {string} nodeId
   * @param {string} cmds
   * @param {{ powershell?: boolean; timeoutMs?: number; reply?: boolean }} [runOpts]
   */
  async function runCommand(nodeId, cmds, runOpts = {}) {
    const powershell = runOpts.powershell === true;
    const reply = runOpts.reply !== false;
    const timeoutMs = runOpts.timeoutMs ?? 180_000;
    if (!reply) {
      // Fire-and-forget: do not wait for agent stdout (needed for long installs).
      ws.send(
        JSON.stringify({
          action: "runcommands",
          responseid: responseId,
          nodeids: [nodeId],
          type: powershell ? 2 : 0,
          cmds,
          runAsUser: 0,
          reply: false,
        }),
      );
      return { ok: true, output: "", raw: { reply: false } };
    }
    const msg = await request(
      "runcommands",
      {
        nodeids: [nodeId],
        type: powershell ? 2 : 0,
        cmds,
        runAsUser: 0,
        reply: true,
      },
      {
        timeoutMs,
        match: (m) => {
          // Agent reply is broadcast as `{ action: "msg", type: "runcommands", result: "<stdout>" }`.
          // Do not accept the bare `{ action: "runcommands", result: "ok" }` ACK when reply:true —
          // that arrives before (or without) stdout.
          if (m.responseid != null && m.responseid !== responseId) return false;
          if (m.action === "msg" && (m.type === "runcommands" || m.event === "runcommands")) {
            return true;
          }
          if (m.action === "event" && (m.type === "runcommands" || m.event === "runcommands")) {
            return true;
          }
          if (typeof m.console === "string" || typeof m.output === "string") return true;
          return false;
        },
      },
    );
    const output =
      typeof msg.console === "string"
        ? msg.console
        : typeof msg.output === "string"
          ? msg.output
          : typeof msg.result === "string"
            ? msg.result
            : typeof msg.msg === "string"
              ? msg.msg
              : JSON.stringify(msg);
    const ok =
      msg.action === "msg" ||
      msg.result == null ||
      msg.result === "ok" ||
      msg.result === "OK" ||
      typeof msg.console === "string" ||
      typeof msg.output === "string" ||
      (typeof msg.result === "string" && msg.result.length > 0);
    return { ok: Boolean(ok), output, raw: msg };
  }

  async function close() {
    waiters.length = 0;
    if (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING) {
      ws.close();
    }
  }

  return { close, request, listNodes, power, runCommand };
}

/**
 * Flatten MeshCentral nodes payload (meshid → node[]) into a flat array.
 * @param {unknown} nodes
 * @returns {Record<string, unknown>[]}
 */
export function flattenNodesPayload(nodes) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  if (!nodes || typeof nodes !== "object") return out;
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      if (isObject(n)) out.push(n);
    }
    return out;
  }
  for (const [meshid, list] of Object.entries(nodes)) {
    /** @type {unknown[]} */
    let items = [];
    if (Array.isArray(list)) {
      items = list;
    } else if (list && typeof list === "object") {
      items = Object.values(list);
    } else {
      continue;
    }
    for (const n of items) {
      if (!isObject(n)) continue;
      out.push({ ...n, meshid: typeof n.meshid === "string" ? n.meshid : meshid });
    }
  }
  return out;
}
