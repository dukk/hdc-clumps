/**
 * @param {string} uri
 * @returns {{ user: string, host: string } | null}
 */
export function parseSshUri(uri) {
  if (typeof uri !== "string" || !uri.trim()) return null;
  const u = uri.trim();
  if (!u.startsWith("ssh://")) return null;
  const rest = u.slice("ssh://".length);
  const at = rest.lastIndexOf("@");
  if (at === -1) {
    const host = rest.split("/")[0];
    return host ? { user: "", host } : null;
  }
  const user = rest.slice(0, at);
  const host = rest.slice(at + 1).split("/")[0];
  if (!host) return null;
  return { user: user || "", host };
}

/**
 * @param {string} url
 * @param {string} fallbackHost
 * @returns {{ args: string } | null}
 */
export function httpCheckArgs(url, fallbackHost) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    const proto = u.protocol.replace(":", "");
    if (proto !== "http" && proto !== "https") return null;
    const host = u.hostname || fallbackHost;
    const port = u.port || (proto === "https" ? "443" : "80");
    const ssl = proto === "https" ? " -S" : "";
    return { args: `-H ${host} -p ${port}${ssl}` };
  } catch {
    return null;
  }
}
