import { stderr as errout } from "node:process";

const USER_AGENT = "hdc-minecraft/1.0 (https://github.com/dukk/hdc-clumps)";
const XUID_RE = /^\d{15,17}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOODGATE_UUID_RE = /^00000000-0000-0000-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Floodgate Java UUID from Xbox XUID (`new UUID(0, xuid)`).
 * @param {string | number | bigint} xuid
 */
export function xuidToFloodgateUuid(xuid) {
  const n = typeof xuid === "bigint" ? xuid : BigInt(String(xuid).trim());
  if (n < 0n) throw new Error(`invalid Floodgate XUID: ${String(xuid)}`);
  const hex = n.toString(16).padStart(16, "0");
  return `00000000-0000-0000-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/**
 * @param {string} uuid
 */
export function isFloodgateUuid(uuid) {
  return FLOODGATE_UUID_RE.test(String(uuid || "").trim());
}

/**
 * @param {string} name
 * @param {string} [prefix]
 */
export function applyFloodgatePrefix(name, prefix = ".") {
  const n = String(name || "").trim();
  const p = String(prefix ?? ".");
  if (!n) return n;
  if (!p || n.startsWith(p)) return n;
  return `${p}${n}`;
}

/**
 * @param {unknown} data
 * @returns {string | null}
 */
export function parseGeyserXuidJson(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const xuid = /** @type {Record<string, unknown>} */ (data).xuid;
  const s = typeof xuid === "number" && Number.isFinite(xuid) ? String(xuid) : String(xuid || "").trim();
  return XUID_RE.test(s) ? s : null;
}

/**
 * @param {unknown} data
 * @returns {string | null}
 */
export function parsePlayerDbXuidJson(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rec = /** @type {Record<string, unknown>} */ (data);
  const inner = rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)
    ? /** @type {Record<string, unknown>} */ (rec.data)
    : rec;
  const player = inner.player && typeof inner.player === "object" && !Array.isArray(inner.player)
    ? /** @type {Record<string, unknown>} */ (inner.player)
    : inner;
  const id = player.id ?? player.xuid ?? rec.id;
  const s = typeof id === "number" && Number.isFinite(id) ? String(id) : String(id || "").trim();
  return XUID_RE.test(s) ? s : null;
}

/**
 * @param {string} html
 * @returns {string | null}
 */
export function parseXboxReplayXuid(html) {
  const m = String(html || "").match(/xuid-(\d{15,17})/i);
  return m && XUID_RE.test(m[1]) ? m[1] : null;
}

/**
 * @param {string} url
 * @param {"json" | "text"} kind
 */
async function fetchBody(url, kind) {
  const res = await fetch(url, {
    headers: {
      Accept: kind === "json" ? "application/json" : "text/html",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) return { ok: false, status: res.status, body: null };
  if (kind === "json") {
    try {
      return { ok: true, status: res.status, body: await res.json() };
    } catch {
      return { ok: false, status: res.status, body: null };
    }
  }
  return { ok: true, status: res.status, body: await res.text() };
}

/**
 * @param {string} gamertag
 * @returns {Promise<string>}
 */
export async function fetchXboxXuid(gamertag) {
  const gt = String(gamertag || "").trim();
  if (!gt) throw new Error("Bedrock whitelist entry missing gamertag");
  const encoded = encodeURIComponent(gt);

  const geyser = await fetchBody(`https://api.geysermc.org/v2/xbox/xuid/${encoded}`, "json");
  const geyserXuid = geyser.ok ? parseGeyserXuidJson(geyser.body) : null;
  if (geyserXuid) return geyserXuid;

  const playerDb = await fetchBody(`https://playerdb.co/api/player/xbox/${encoded}`, "json");
  const playerDbXuid = playerDb.ok ? parsePlayerDbXuidJson(playerDb.body) : null;
  if (playerDbXuid) return playerDbXuid;

  const replay = await fetchBody(`https://www.xboxreplay.net/player/${encoded}`, "text");
  const replayXuid = replay.ok && typeof replay.body === "string" ? parseXboxReplayXuid(replay.body) : null;
  if (replayXuid) return replayXuid;

  throw new Error(
    `could not resolve Xbox XUID for Bedrock gamertag ${JSON.stringify(gt)} (Geyser HTTP ${geyser.status}, PlayerDB HTTP ${playerDb.status}, XboxReplay HTTP ${replay.status})`,
  );
}

/**
 * @param {{ uuid?: string, name: string, edition?: string, xuid?: string }} player
 */
export async function resolveWhitelistPlayer(player) {
  const name = String(player?.name || "").trim();
  const edition = player?.edition === "bedrock" ? "bedrock" : "java";
  let uuid = String(player?.uuid || "").trim();
  let xuid = String(player?.xuid || "").trim();
  if (edition === "java") {
    if (!UUID_RE.test(uuid) || !name) {
      throw new Error(`Java whitelist entry needs uuid + name (${JSON.stringify(name || uuid)})`);
    }
    return { uuid, name, edition, ...(xuid ? { xuid } : {}) };
  }
  if (!name) throw new Error("Bedrock whitelist entry needs name (Xbox gamertag)");
  if (!UUID_RE.test(uuid)) {
    if (!XUID_RE.test(xuid)) {
      errout.write(`[hdc] minecraft whitelist: resolving Bedrock XUID for ${name} …\n`);
      xuid = await fetchXboxXuid(name);
    }
    uuid = xuidToFloodgateUuid(xuid);
    errout.write(`[hdc] minecraft whitelist: ${name} → ${uuid}\n`);
  } else if (!XUID_RE.test(xuid) && isFloodgateUuid(uuid)) {
    xuid = BigInt(`0x${uuid.replace(/-/g, "").slice(16)}`).toString(10);
  }
  return { uuid, name, edition, ...(XUID_RE.test(xuid) ? { xuid } : {}) };
}

/**
 * @param {{ uuid?: string, name: string, edition?: string, xuid?: string }[]} players
 */
export async function resolveWhitelistPlayers(players) {
  if (!Array.isArray(players)) return [];
  /** @type {{ uuid: string, name: string, edition: string, xuid?: string }[]} */
  const out = [];
  for (const p of players) {
    out.push(await resolveWhitelistPlayer(p));
  }
  return out;
}

/**
 * Paper whitelist.json entries (uuid + name only). Bedrock names get the Floodgate prefix.
 * @param {{ uuid: string, name: string, edition?: string }[]} players
 * @param {string} [prefix]
 */
export function toPaperWhitelistPlayers(players, prefix = ".") {
  if (!Array.isArray(players)) return [];
  return players.map((p) => ({
    uuid: String(p.uuid || "").trim(),
    name: p.edition === "bedrock" ? applyFloodgatePrefix(p.name, prefix) : String(p.name || "").trim(),
  }));
}
