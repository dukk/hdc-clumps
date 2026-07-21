import { stderr } from "node:process";

/**
 * @param {import('./slack-config.mjs').SlackConfigApp[]} apps
 */
export function printSlackPortalChecklist(apps) {
  const managed = apps.filter((a) => a.managed);
  if (!managed.length) return;
  stderr.write("\n=== Slack portal checklist (API cannot complete these) ===\n");
  for (const app of managed) {
    stderr.write(`\n[${app.id}] ${app.display_name}\n`);
    if (app.match.app_id) stderr.write(`  app_id: ${app.match.app_id}\n`);
    if (app.icon?.repo_path) {
      stderr.write(`  icon: ${app.icon.repo_path} (managed via apps.icon.set)\n`);
    }
    stderr.write(`  bot_token vault: ${app.vault.bot_token_key}\n`);
    stderr.write(`  signing_secret vault: ${app.vault.signing_secret_key}\n`);
    if (app.portal_checklist.notes) {
      stderr.write(`  notes: ${app.portal_checklist.notes}\n`);
    }
  }
  stderr.write("\n");
}
