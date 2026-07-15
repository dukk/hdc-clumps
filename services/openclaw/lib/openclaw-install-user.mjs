/**
 * @param {Record<string, unknown>} install
 */
export function resolveLinuxUser(install) {
  const raw =
    typeof install.linux_user === "string" && install.linux_user.trim()
      ? install.linux_user.trim()
      : "openclaw";
  if (!/^[a-z][a-z0-9_-]*$/.test(raw)) {
    throw new Error(`install.linux_user invalid: ${JSON.stringify(raw)}`);
  }
  return raw;
}
