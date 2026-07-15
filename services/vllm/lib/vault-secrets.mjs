import { stderr as errout } from "node:process";

import { hfTokenVaultKey } from "./vllm-render.mjs";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Prefer env (HDC_HF_TOKEN / HF_TOKEN); vault lookup is best-effort and never blocks on prompts.
 * @param {ReturnType<import("./vault-deps.mjs").createVllmVaultAccess>} _vault
 * @param {Record<string, unknown>} vllm
 */
export async function resolveVllmSecrets(_vault, vllm) {
  const cfg = isObject(vllm) ? vllm : {};
  const key = hfTokenVaultKey(cfg);

  const fromEnv =
    (typeof process.env.HDC_HF_TOKEN === "string" && process.env.HDC_HF_TOKEN.trim()) ||
    (typeof process.env.HF_TOKEN === "string" && process.env.HF_TOKEN.trim()) ||
    (typeof process.env.HUGGING_FACE_HUB_TOKEN === "string" &&
      process.env.HUGGING_FACE_HUB_TOKEN.trim()) ||
    "";
  if (fromEnv) {
    errout.write(`[hdc] vllm: Hugging Face token loaded from environment\n`);
    return { hfToken: fromEnv, hfTokenVaultKey: key };
  }

  errout.write(
    `[hdc] vllm: warning — ${key} not in env; gated HF models (Gemma) may fail until set. Export HDC_HF_TOKEN or: node apps/hdc-cli/cli.mjs secrets set ${key}\n`,
  );
  return { hfToken: "", hfTokenVaultKey: key };
}
