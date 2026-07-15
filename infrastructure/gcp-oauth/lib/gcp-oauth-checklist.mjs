/**
 * @param {string} line
 * @param {(msg: string) => void} log
 */
function logBlock(line, log) {
  log(line);
}

/**
 * @param {object} opts
 * @param {string} opts.consoleUrl
 * @param {string} opts.projectId
 * @param {ReturnType<import('./gcp-oauth-validate.mjs').resolveEffectiveApplication>[]} opts.applications
 * @param {(msg: string) => void} opts.log
 */
export function printConsoleChecklist(opts) {
  const { consoleUrl, projectId, applications, log } = opts;
  logBlock("", log);
  logBlock("=== Google Auth Platform Console checklist ===", log);
  if (projectId) logBlock(`Project: ${projectId}`, log);
  logBlock(`Credentials: ${consoleUrl || "https://console.cloud.google.com/apis/credentials"}`, log);
  logBlock("", log);
  logBlock("For each application, create or edit a Web application OAuth client:", log);
  logBlock("", log);

  for (const app of applications) {
    logBlock(`--- ${app.display_name} (${app.id}) ---`, log);
    logBlock(`  Client type: ${app.client_type}`, log);
    if (app.redirect_uris.length) {
      logBlock("  Authorized redirect URIs:", log);
      for (const u of app.redirect_uris) logBlock(`    ${u}`, log);
    }
    if (app.javascript_origins.length) {
      logBlock("  Authorized JavaScript origins:", log);
      for (const o of app.javascript_origins) logBlock(`    ${o}`, log);
    }
    if (app.existing_client_id) {
      logBlock(`  Existing client ID (config): ${app.existing_client_id}`, log);
    }
    logBlock("  After create: download JSON and run maintain --import <file>", log);
    logBlock("", log);
  }
}
