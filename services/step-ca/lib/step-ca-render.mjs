/**
 * @param {string} s
 */
export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").stepCaGlobalSettings>} global
 * @param {string} passwordFileRemote absolute path on guest for init --password-file
 */
export function buildStepCaInitCommand(global, passwordFileRemote) {
  const dnsFlags = global.dnsNames.map((d) => `--dns=${shellQuote(d)}`).join(" ");
  const acme = global.enableAcme ? " --acme" : "";
  const stepPath = shellQuote(global.stepPath);
  return `export STEPPATH=${stepPath}; mkdir -p "$STEPPATH" && step ca init --deployment-type=${shellQuote(global.deploymentType)} --name=${shellQuote(global.caName)} ${dnsFlags} --address=${shellQuote(global.listenAddress)} --provisioner=${shellQuote(global.provisionerName)} --password-file=${shellQuote(passwordFileRemote)} --provisioner-password-file=${shellQuote(passwordFileRemote)}${acme}`;
}

/**
 * Normalize paths in ca.json after init (HOME/.step → /etc/step-ca).
 * @param {string} content
 * @param {string} stepPath
 */
export function rewriteCaJsonPaths(content, stepPath) {
  const base = stepPath.replace(/\/$/, "");
  return content
    .replace(/\$HOME\/\.step/g, base)
    .replace(/~\/\.step/g, base)
    .replace(/\/root\/\.step/g, base);
}

/**
 * Patch listen address in ca.json when operator changes config.
 * @param {string} content
 * @param {string} listenAddress e.g. :443
 */
export function patchCaJsonListenAddress(content, listenAddress) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      parsed.address = listenAddress;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    }
  } catch {
    /* fall through */
  }
  return content;
}

/**
 * @param {string} stepPath
 */
export function renderSystemdUnit(stepPath) {
  const base = stepPath.replace(/\/$/, "");
  return `[Unit]
Description=step-ca Certificate Authority
Documentation=https://smallstep.com/docs/step-ca
After=network-online.target
Wants=network-online.target
ConditionFileNotEmpty=${base}/config/ca.json
ConditionFileNotEmpty=${base}/password.txt

[Service]
Type=simple
User=step
Group=step
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Environment=STEPPATH=${base}
WorkingDirectory=${base}
ExecStart=/usr/bin/step-ca ${base}/config/ca.json --password-file=${base}/password.txt
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Remote script: ensure step user owns STEPPATH and password file permissions.
 * @param {string} stepPath
 */
export function chownStepCaTreeCommand(stepPath) {
  const base = shellQuote(stepPath.replace(/\/$/, ""));
  return `id step >/dev/null 2>&1 || useradd --system --home ${base} --shell /usr/sbin/nologin step 2>/dev/null || true
chown -R step:step ${base}
chmod 700 ${base}
chmod 600 ${base}/password.txt 2>/dev/null || true
chmod 600 ${base}/secrets/* 2>/dev/null || true`;
}

/**
 * Health probe when listen uses TLS on 443.
 * @param {string} listenAddress
 */
export function stepCaHealthProbeCommand(listenAddress) {
  const port = listenAddress.startsWith(":") ? listenAddress.slice(1) : "443";
  return `curl -sfk https://127.0.0.1:${port}/health 2>/dev/null || step ca health 2>/dev/null || systemctl is-active step-ca`;
}
