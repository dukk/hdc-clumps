export const GITHUB_REPO = "gitroomhq/postiz-app";
export const GITHUB_RELEASES_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/**
 * @param {string} tag
 */
export function normalizeReleaseTag(tag) {
  const t = String(tag).trim();
  if (!t) throw new Error("release tag is empty");
  return t.startsWith("v") ? t : `v${t}`;
}

/**
 * @param {string} tag
 */
export function releaseTarballUrl(tag) {
  const normalized = normalizeReleaseTag(tag);
  return `https://github.com/${GITHUB_REPO}/archive/refs/tags/${encodeURIComponent(normalized)}.tar.gz`;
}

/**
 * @param {unknown} releaseSpec
 */
export function isLatestReleaseSpec(releaseSpec) {
  const s = typeof releaseSpec === "string" ? releaseSpec.trim().toLowerCase() : "latest";
  return !s || s === "latest";
}

/**
 * @param {unknown} body
 * @returns {{ tag: string; tarballUrl: string }}
 */
export function parseGithubLatestRelease(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid GitHub release JSON");
  }
  const rec = /** @type {Record<string, unknown>} */ (body);
  const tag =
    typeof rec.tag_name === "string" && rec.tag_name.trim()
      ? rec.tag_name.trim()
      : typeof rec.name === "string" && rec.name.trim()
        ? rec.name.trim()
        : "";
  if (!tag) throw new Error("GitHub release missing tag_name");
  return { tag: normalizeReleaseTag(tag), tarballUrl: releaseTarballUrl(tag) };
}

/**
 * @param {unknown} releaseSpec
 */
export async function resolveReleaseTarget(releaseSpec) {
  if (!isLatestReleaseSpec(releaseSpec)) {
    const tag = normalizeReleaseTag(String(releaseSpec));
    return { tag, tarballUrl: releaseTarballUrl(tag), source: "pinned" };
  }
  const res = await fetch(GITHUB_RELEASES_LATEST, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "hdc-postiz" },
  });
  if (!res.ok) {
    throw new Error(`GitHub releases/latest failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const parsed = parseGithubLatestRelease(body);
  return { ...parsed, source: "latest" };
}

/**
 * @returns {Promise<string | null>}
 */
export async function fetchLatestReleaseTag() {
  try {
    const { tag } = await resolveReleaseTarget("latest");
    return tag;
  } catch {
    return null;
  }
}
