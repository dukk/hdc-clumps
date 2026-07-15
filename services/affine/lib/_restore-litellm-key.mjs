import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stderr as errout } from "node:process";

import { repoRoot } from "hdc/cli/paths.mjs";
import { bootstrapGlobalEnv } from "hdc/cli/lib/clump-env.mjs";
import { createNodeCliDeps } from "hdc/cli/lib/node-cli-deps.mjs";
import { pctExec } from "hdc/package/pve-pct-remote.mjs";
import { resolvePveSshForHost } from "../../pi-hole/lib/pi-hole-install.mjs";
import { createLitellmVaultAccess } from "../../litellm/lib/vault-deps.mjs";

const root = repoRoot();
bootstrapGlobalEnv(createNodeCliDeps(), root);

const proxmoxRoot = join(root, "clumps", "infrastructure", "proxmox");
const pve = resolvePveSshForHost(proxmoxRoot, "pve-a");
errout.write(`[hdc] reading LiteLLM master key from CT 505 on ${pve.host} (value not logged)\n`);
const r = pctExec(
  pve.user,
  pve.host,
  505,
  "grep -E '^(LITELLM_MASTER_KEY|MASTER_KEY)=' /opt/litellm/.env 2>/dev/null | head -n1",
  { capture: true },
);
if (r.status !== 0 || !String(r.stdout || "").trim()) {
  errout.write(`[hdc] failed to read key from guest .env status=${r.status}\n`);
  process.exitCode = 1;
  throw new Error("guest .env read failed");
}
const line = String(r.stdout).trim().split(/\r?\n/)[0];
const idx = line.indexOf("=");
let key = idx >= 0 ? line.slice(idx + 1).trim() : "";
if (
  (key.startsWith('"') && key.endsWith('"')) ||
  (key.startsWith("'") && key.endsWith("'"))
) {
  key = key.slice(1, -1);
}
if (!key || !key.startsWith("sk-")) {
  errout.write(`[hdc] guest key missing or not sk- prefix (len=${key.length})\n`);
  process.exitCode = 1;
  throw new Error("invalid guest key");
}
const vault = createLitellmVaultAccess();
await vault.unlock({});
await vault.setSecret("HDC_LITELLM_MASTER_KEY", key);
errout.write(
  `[hdc] restored HDC_LITELLM_MASTER_KEY to vault from litellm-a guest .env (len=${key.length})\n`,
);

const self = fileURLToPath(import.meta.url);
try {
  unlinkSync(self);
} catch {
  /* ignore */
}
