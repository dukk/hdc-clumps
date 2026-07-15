import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { bootstrapGlobalEnv } from "hdc/cli/lib/clump-env.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";

bootstrapGlobalEnv(createNodeCliDeps(), repoRoot());
const pve = resolvePveSshForHost(join(repoRoot(), "clumps", "infrastructure", "proxmox"), "pve-c");

const mail = pctExec(pve.user, pve.host, 511, "grep -E '^MAILER_' /opt/affine/.env || true", {
  capture: true,
});
const mailKeys = String(mail.stdout || "")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => l.split("=")[0]);
errout.write(`[verify] MAILER keys: ${mailKeys.join(", ") || "(none)"}\n`);

const cfg = pctExec(
  pve.user,
  pve.host,
  511,
  [
    "python3 - <<'PY'",
    "import json",
    "d=json.load(open('/opt/affine/config/config.json'))",
    "c=d.get('copilot',{})",
    "print('enabled', c.get('enabled'))",
    "p=c.get('providers.openai',{})",
    "print('baseUrl', p.get('baseUrl'))",
    "print('hasApiKey', bool(p.get('apiKey')))",
    "print('oldApiStyle', p.get('oldApiStyle'))",
    "print('chat', c.get('scenarios',{}).get('scenarios',{}).get('chat'))",
    "PY",
  ].join("\n"),
  { capture: true },
);
errout.write(`[verify] copilot:\n${String(cfg.stdout || cfg.stderr || "").trim()}\n`);

try {
  unlinkSync(fileURLToPath(import.meta.url));
} catch {
  /* ignore */
}
