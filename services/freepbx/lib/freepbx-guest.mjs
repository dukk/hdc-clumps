import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { authorizeProxmoxForHost } from "../../../infrastructure/proxmox/lib/proxmox-deploy-auth.mjs";
import { pveData, pveFormBody, pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { buildApplyPayload } from "./freepbx-settings.mjs";
import { sshBashStdin } from "./ssh-stream.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} url
 * @param {boolean} force
 */
export function freepbxInstallScript(url, force) {
  const quoted = shellQuote(url);
  const skip = force
    ? "echo reinstall requested"
    : `if command -v fwconsole >/dev/null 2>&1; then echo "fwconsole already present"; exit 0; fi`;
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
${skip}
cd /tmp
wget -q -O sng_freepbx_debian_install.sh ${quoted}
bash sng_freepbx_debian_install.sh
`;
}

/**
 * @param {ReturnType<typeof buildApplyPayload>} payload
 */
export function freepbxApplyScript(payload) {
  const php = readFileSync(join(here, "apply-freepbx.php"), "utf8");
  const json = JSON.stringify(payload);
  const localNet = typeof payload.local_net === "string" ? payload.local_net.trim() : "";
  void localNet;
  const trust = "fwconsole firewall disable || true";
  return `set -euo pipefail
cleanup() { rm -f /tmp/hdc-freepbx-apply.php /tmp/hdc-freepbx-apply.json; }
trap cleanup EXIT
umask 077
cat > /tmp/hdc-freepbx-apply.php << 'HDC_FPBX_PHP_EOF'
${php}
HDC_FPBX_PHP_EOF
cat > /tmp/hdc-freepbx-apply.json << 'HDC_FPBX_JSON_EOF'
${json}
HDC_FPBX_JSON_EOF
php /tmp/hdc-freepbx-apply.php
fwconsole reload
${trust}
`;
}

export const FREEPBX_QUERY_SCRIPT = `set -euo pipefail
echo "fwconsole: $(fwconsole --version 2>/dev/null || echo missing)"
echo "asterisk: $(systemctl is-active asterisk 2>/dev/null || echo unknown)"
echo "httpd: $(systemctl is-active apache2 2>/dev/null || systemctl is-active httpd 2>/dev/null || echo unknown)"
asterisk -rx 'pjsip show registrations' 2>/dev/null | head -n 40 || true
code=$(curl -k -s -o /dev/null -w '%{http_code}' https://127.0.0.1/admin/ || echo 000)
echo "admin_http: $code"
`;

/**
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.host
 * @param {string} opts.installUrl
 * @param {boolean} opts.force
 * @param {(line: string) => void} opts.log
 */
export function installFreepbx(opts) {
  opts.log("Installing FreePBX 17 (this can take over an hour) …");
  const r = sshBashStdin({
    user: opts.user,
    host: opts.host,
    script: freepbxInstallScript(opts.installUrl, opts.force),
    timeoutMs: INSTALL_TIMEOUT_MS,
    log: opts.log,
  });
  if (r.status !== 0) {
    throw new Error(
      r.timedOut ? "FreePBX installer timed out" : `FreePBX installer failed (exit ${r.status})`,
    );
  }
  return { ok: true };
}

/**
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.host
 * @param {ReturnType<typeof buildApplyPayload>} opts.payload
 * @param {(line: string) => void} opts.log
 */
/**
 * Turn off the FreePBX firewall from the Proxmox guest agent so operator SSH
 * is not dropped when the module starts.
 * @param {object} opts
 * @param {string} opts.proxmoxRoot
 * @param {string} opts.hostId
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {(line: string) => void} opts.log
 */
export async function disableFreepbxFirewall(opts) {
  opts.log(`Disabling FreePBX firewall on vmid ${opts.vmid} via guest agent …`);
  const auth = await authorizeProxmoxForHost({ clumpRoot: opts.proxmoxRoot, hostId: opts.hostId });
  const body = await pveJsonRequest(
    "POST",
    auth.host.apiBase,
    `/nodes/${encodeURIComponent(opts.node)}/qemu/${encodeURIComponent(String(opts.vmid))}/agent/exec`,
    auth.authorization,
    auth.rejectUnauthorized,
    pveFormBody({ command: ["/usr/sbin/fwconsole", "firewall", "disable"] }),
  );
  const data = pveData(body);
  const pid = data && typeof data === "object" && "pid" in data ? Number(data.pid) : NaN;
  if (!Number.isFinite(pid)) throw new Error("guest agent exec did not return a pid");
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusBody = await pveJsonRequest(
      "GET",
      auth.host.apiBase,
      `/nodes/${encodeURIComponent(opts.node)}/qemu/${encodeURIComponent(String(opts.vmid))}/agent/exec-status?pid=${pid}`,
      auth.authorization,
      auth.rejectUnauthorized,
    );
    const status = pveData(statusBody);
    if (status && typeof status === "object" && status.exited) {
      const out = Buffer.from(String(status["out-data"] ?? ""), "base64").toString("utf8");
      const err = Buffer.from(String(status["err-data"] ?? ""), "base64").toString("utf8");
      if (out.trim()) opts.log(out.trim());
      if (err.trim()) opts.log(err.trim());
      if (Number(status.exitcode) !== 0) {
        throw new Error(`fwconsole firewall disable exited ${status.exitcode}`);
      }
      return { ok: true };
    }
  }
  throw new Error("fwconsole firewall disable did not finish");
}

export function applyFreepbx(opts) {
  opts.log("Applying FreePBX admin password, NAT/RTP, and Twilio trunk …");
  const r = sshBashStdin({
    user: opts.user,
    host: opts.host,
    script: freepbxApplyScript(opts.payload),
    timeoutMs: 20 * 60 * 1000,
    log: opts.log,
  });
  if (r.status !== 0) {
    throw new Error(`FreePBX apply failed (exit ${r.status})`);
  }
  return { ok: true };
}
