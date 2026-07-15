import { shellQuote, stepCaHealthProbeCommand } from "./step-ca-render.mjs";
import { caConfigPath } from "./step-ca-install.mjs";

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryStepCaServiceActive(exec) {
  const r = exec.run("systemctl is-active step-ca 2>/dev/null || echo inactive", {
    capture: true,
  });
  const active = r.stdout.trim() === "active";
  return { active, status: r.stdout.trim() || "unknown", exit: r.status };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} listenAddress
 */
export function queryStepCaHealth(exec, listenAddress) {
  const cmd = stepCaHealthProbeCommand(listenAddress);
  const r = exec.run(cmd, { capture: true });
  const output = `${r.stdout}${r.stderr}`.trim();
  return { ok: r.status === 0, output: output.slice(0, 500), exit: r.status };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} stepPath
 */
export function queryStepCaInitialized(exec, stepPath) {
  const configPath = caConfigPath(stepPath.replace(/\/$/, ""));
  const r = exec.run(`test -s ${shellQuote(configPath)}`, { capture: true });
  const rootCert = `${stepPath.replace(/\/$/, "")}/certs/root_ca.crt`;
  const certR = exec.run(`test -f ${shellQuote(rootCert)}`, { capture: true });
  return {
    ok: r.status === 0,
    config_path: configPath,
    config_present: r.status === 0,
    root_ca_present: certR.status === 0,
    root_ca_path: rootCert,
  };
}
