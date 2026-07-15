/**
 * Run remote shell/PowerShell commands via MeshCentral agents.
 */

/**
 * @param {import("./meshcentral-api.mjs").MeshcentralApiClient} client
 * @param {string} nodeId
 * @param {string} command
 * @param {{ platform?: string; dryRun?: boolean; log?: (line: string) => void; timeoutMs?: number }} [opts]
 */
export async function runOnDevice(client, nodeId, command, opts = {}) {
  const log = opts.log ?? (() => {});
  const platform = String(opts.platform || "unknown").toLowerCase();
  const powershell = platform === "windows";
  if (opts.dryRun) {
    log(`dry-run: would run on ${nodeId}: ${command.slice(0, 120)}${command.length > 120 ? "…" : ""}`);
    return { ok: true, dry_run: true, output: "", powershell };
  }
  log(`runcommands on ${nodeId} (${powershell ? "powershell" : "shell"}${opts.reply === false ? ", no-reply" : ""}) …`);
  const result = await client.runCommand(nodeId, command, {
    powershell,
    timeoutMs: opts.timeoutMs,
    reply: opts.reply,
  });
  return { ...result, powershell };
}
