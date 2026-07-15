/**
 * @param {string} line
 * @param {(msg: string) => void} log
 */
function logBlock(line, log) {
  log(line);
}

/**
 * @param {object} opts
 * @param {string} opts.developerPortalUrl
 * @param {import('./discord-config.mjs').ConfigApplication[]} opts.applications
 * @param {(msg: string) => void} opts.log
 */
export function printDeveloperPortalChecklist(opts) {
  const { developerPortalUrl, applications, log } = opts;
  logBlock("", log);
  logBlock("=== Discord Developer Portal checklist ===", log);
  logBlock(`Portal: ${developerPortalUrl}`, log);
  logBlock("", log);
  logBlock("Discord has no public API to create applications or enable privileged Gateway Intents.", log);
  logBlock("Complete these steps manually when query reports portal_checklist items:", log);
  logBlock("", log);

  for (const app of applications) {
    logBlock(`--- ${app.display_name} (${app.id}) ---`, log);
    if (app.match.application_id) {
      logBlock(`  Application ID: ${app.match.application_id}`, log);
      logBlock(`  Direct link: ${developerPortalUrl}/${app.match.application_id}`, log);
    } else {
      logBlock("  Application ID: not set — run query --import --yes after bot token is in vault", log);
    }
    if (app.portal_checklist.privileged_intents.length) {
      logBlock("  Privileged Gateway Intents (Bot tab):", log);
      for (const intent of app.portal_checklist.privileged_intents) {
        logBlock(`    - ${intent}`, log);
      }
    }
    if (app.portal_checklist.notes) {
      logBlock(`  Notes: ${app.portal_checklist.notes}`, log);
    }
    logBlock("", log);
  }
}
