/**
 * Strip ANSI escape sequences from SafeLine CLI output.
 * @param {string} text
 */
export function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Parse `docker exec safeline-mgt resetadmin` output.
 * @param {string} output
 * @returns {{ username: string; password: string } | null}
 */
export function parseResetAdminOutput(output) {
  const clean = stripAnsi(output);
  const usernameMatch = clean.match(/Initial username[：:]\s*(\S+)/i);
  const passwordMatch = clean.match(/Initial password[：:]\s*(\S+)/i);
  const username = usernameMatch?.[1]?.trim() || "admin";
  const password = passwordMatch?.[1]?.trim() || "";
  if (!password) return null;
  return { username, password };
}
