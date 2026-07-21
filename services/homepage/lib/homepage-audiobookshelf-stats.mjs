import http from "node:http";
import https from "node:https";

/** @typedef {"audiobooks" | "ebooks" | "other"} AudiobookshelfStatsBucket */

/** @typedef {{ audiobooks?: string[]; ebooks?: string[]; other?: string[] }} AudiobookshelfLibraryBuckets */

/**
 * @typedef {object} AudiobookshelfLibrary
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [mediaType]
 * @property {{ fullPath?: string }[]} [folders]
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {AudiobookshelfLibraryBuckets | undefined} buckets
 */
function normalizeLibraryBuckets(buckets) {
  /** @type {AudiobookshelfLibraryBuckets} */
  const out = {};
  if (!buckets || !isObject(buckets)) return out;
  for (const key of /** @type {const} */ (["audiobooks", "ebooks", "other"])) {
    const raw = buckets[key];
    if (!Array.isArray(raw)) continue;
    const names = raw
      .filter((n) => typeof n === "string" && n.trim())
      .map((n) => n.trim());
    if (names.length) out[key] = names;
  }
  return out;
}

/**
 * @param {AudiobookshelfLibrary} library
 */
export function libraryFolderPaths(library) {
  if (!Array.isArray(library.folders)) return [];
  return library.folders
    .map((f) => (isObject(f) && typeof f.fullPath === "string" ? f.fullPath.trim() : ""))
    .filter(Boolean);
}

/**
 * @param {AudiobookshelfLibrary} library
 * @param {AudiobookshelfLibraryBuckets} [libraryBuckets]
 * @returns {AudiobookshelfStatsBucket}
 */
export function classifyAudiobookshelfLibrary(library, libraryBuckets) {
  const name = typeof library.name === "string" ? library.name.trim() : "";
  const buckets = normalizeLibraryBuckets(libraryBuckets);

  for (const bucket of /** @type {const} */ (["audiobooks", "ebooks", "other"])) {
    const names = buckets[bucket];
    if (names?.includes(name)) return bucket;
  }

  const mediaType = typeof library.mediaType === "string" ? library.mediaType.trim().toLowerCase() : "";
  if (mediaType === "podcast") return "other";

  const paths = libraryFolderPaths(library);
  const pathText = paths.join("\0").toLowerCase();
  const nameLower = name.toLowerCase();

  if (mediaType === "book") {
    if (pathText.includes("/audiobooks") || /audiobook/.test(nameLower)) return "audiobooks";
    if (pathText.includes("/ebooks") || /ebook/.test(nameLower)) return "ebooks";
  }

  return "other";
}

/**
 * @typedef {{ totalItems: number; totalSize: number }} AudiobookshelfLibraryStats
 */

/**
 * @param {unknown} value
 */
function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * @param {AudiobookshelfLibrary[]} libraries
 * @param {Record<string, AudiobookshelfLibraryStats>} statsByLibraryId
 * @param {AudiobookshelfLibraryBuckets} [libraryBuckets]
 */
export function aggregateAudiobookshelfCounts(libraries, statsByLibraryId, libraryBuckets) {
  /** @type {Record<AudiobookshelfStatsBucket, number>} */
  const counts = { audiobooks: 0, ebooks: 0, other: 0 };
  let totalStorageBytes = 0;

  for (const library of libraries) {
    const id = typeof library.id === "string" ? library.id : "";
    const stats = id && statsByLibraryId[id] ? statsByLibraryId[id] : { totalItems: 0, totalSize: 0 };
    const bucket = classifyAudiobookshelfLibrary(library, libraryBuckets);
    counts[bucket] += stats.totalItems;
    totalStorageBytes += stats.totalSize;
  }

  return { ...counts, total_storage_bytes: totalStorageBytes };
}

/**
 * @param {string} url
 * @param {RequestInit} init
 */
function audiobookshelfFetch(url, init) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    /** @type {import("node:https").RequestOptions} */
    const reqOpts = {
      method: init.method ?? "GET",
      headers: init.headers,
      rejectUnauthorized: parsed.protocol === "https:" ? false : undefined,
    };
    const req = lib.request(url, reqOpts, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} path
 */
async function audiobookshelfRequest(baseUrl, token, path) {
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await audiobookshelfFetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`audiobookshelf API GET ${path} failed (${res.status}): ${res.text.slice(0, 400)}`);
  }
  if (!res.text) return null;
  return JSON.parse(res.text);
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.token
 * @param {AudiobookshelfLibraryBuckets} [opts.libraryBuckets]
 * @param {typeof audiobookshelfRequest} [opts.requestFn]
 */
export async function fetchAudiobookshelfWidgetStats(opts) {
  const { url, token, libraryBuckets, requestFn = audiobookshelfRequest } = opts;
  const data = await requestFn(url, token, "/api/libraries");
  const libraries = isObject(data) && Array.isArray(data.libraries) ? data.libraries : [];
  /** @type {Record<string, AudiobookshelfLibraryStats>} */
  const statsByLibraryId = {};

  for (const raw of libraries) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!id) continue;
    const stats = await requestFn(url, token, `/api/libraries/${encodeURIComponent(id)}/stats`);
    statsByLibraryId[id] = {
      totalItems: isObject(stats) ? nonNegativeInt(stats.totalItems) : 0,
      totalSize: isObject(stats) ? nonNegativeInt(stats.totalSize) : 0,
    };
  }

  return aggregateAudiobookshelfCounts(
    /** @type {AudiobookshelfLibrary[]} */ (libraries.filter(isObject)),
    statsByLibraryId,
    libraryBuckets,
  );
}
