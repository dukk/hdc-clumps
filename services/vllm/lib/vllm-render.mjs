/** @type {readonly string[]} */
export const INSTALL_DEVICES = ["cuda", "cpu"];

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} device
 */
export function normalizeInstallDevice(device) {
  const d = typeof device === "string" ? device.trim().toLowerCase() : "cuda";
  if (!INSTALL_DEVICES.includes(d)) {
    throw new Error(
      `install.device must be one of ${INSTALL_DEVICES.join(", ")} (got ${JSON.stringify(device)})`,
    );
  }
  return d;
}

/**
 * @param {Record<string, unknown>} vllm
 */
export function hostPort(vllm) {
  const p = typeof vllm.port === "number" ? vllm.port : Number(vllm.port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 8000;
}

/**
 * @param {Record<string, unknown>} vllm
 */
export function bindHost(vllm) {
  const h = typeof vllm.host === "string" ? vllm.host.trim() : "";
  return h || "0.0.0.0";
}

/**
 * @param {Record<string, unknown>} install
 */
export function composeDir(install) {
  return typeof install.compose_dir === "string" && install.compose_dir.trim()
    ? install.compose_dir.trim()
    : "/opt/vllm";
}

/**
 * @param {Record<string, unknown>} install
 */
export function hfCacheDir(install) {
  return typeof install.hf_cache_dir === "string" && install.hf_cache_dir.trim()
    ? install.hf_cache_dir.trim()
    : "/var/lib/vllm/hf-cache";
}

/**
 * @param {Record<string, unknown>} install
 * @param {"cuda" | "cpu"} device
 */
export function resolveImage(install, device) {
  if (device === "cpu") {
    const img =
      typeof install.cpu_image === "string" && install.cpu_image.trim()
        ? install.cpu_image.trim()
        : "";
    return img || "vllm/vllm-openai-cpu:latest";
  }
  const img =
    typeof install.cuda_image === "string" && install.cuda_image.trim()
      ? install.cuda_image.trim()
      : "";
  return img || "vllm/vllm-openai:latest";
}

/**
 * @param {Record<string, unknown>} vllm
 */
export function hfTokenVaultKey(vllm) {
  const key =
    typeof vllm.hf_token_vault_key === "string" && vllm.hf_token_vault_key.trim()
      ? vllm.hf_token_vault_key.trim()
      : "HDC_HF_TOKEN";
  return key;
}

/**
 * @param {Record<string, unknown>} vllm
 * @returns {URL | null}
 */
export function parsePublicUrl(vllm) {
  const raw = typeof vllm.public_url === "string" ? vllm.public_url.trim() : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`vllm.public_url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("vllm.public_url must use http:// or https://");
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} vllm
 * @param {string | null} [guestIp]
 */
export function resolveWebUrl(vllm, guestIp = null) {
  const parsed = parsePublicUrl(vllm);
  if (parsed) return parsed.origin.replace(/\/+$/, "");
  const port = hostPort(vllm);
  const ip = typeof guestIp === "string" ? guestIp.trim() : "";
  if (!ip) return null;
  if (port === 80) return `http://${ip}`;
  return `http://${ip}:${port}`;
}

/**
 * @param {string | null} guestIp
 * @param {Record<string, unknown>} vllm
 */
export function resolveUpstreamUrl(guestIp, vllm) {
  const port = hostPort(vllm);
  if (!guestIp) return null;
  return `http://${guestIp}:${port}`;
}

/**
 * @param {string} s
 */
function yamlScalar(s) {
  return JSON.stringify(String(s));
}

/**
 * @param {Record<string, unknown>} vllm
 * @param {"cuda" | "cpu"} device
 * @returns {string[]}
 */
export function buildVllmCommandArgs(vllm, device) {
  const model = typeof vllm.model === "string" ? vllm.model.trim() : "";
  if (!model) throw new Error("vllm.model is required");

  const port = hostPort(vllm);
  const host = bindHost(vllm);
  const maxModelLen =
    typeof vllm.max_model_len === "number" && Number.isFinite(vllm.max_model_len)
      ? Math.floor(vllm.max_model_len)
      : Number(vllm.max_model_len) || 32768;

  /** @type {string[]} */
  const args = [
    model,
    "--host",
    host,
    "--port",
    String(port),
    "--max-model-len",
    String(maxModelLen),
  ];

  if (device === "cuda") {
    const util =
      typeof vllm.gpu_memory_utilization === "number" &&
      Number.isFinite(vllm.gpu_memory_utilization)
        ? vllm.gpu_memory_utilization
        : Number(vllm.gpu_memory_utilization) || 0.9;
    args.push("--gpu-memory-utilization", String(util));
  }

  const served =
    typeof vllm.served_model_name === "string" ? vllm.served_model_name.trim() : "";
  if (served) {
    args.push("--served-model-name", served);
  }

  const dtype = typeof vllm.dtype === "string" ? vllm.dtype.trim() : "";
  if (dtype) {
    args.push("--dtype", dtype);
  }

  const extra = Array.isArray(vllm.extra_args) ? vllm.extra_args : [];
  for (const a of extra) {
    if (typeof a === "string" && a.trim()) args.push(a.trim());
  }

  return args;
}

/**
 * @param {Record<string, unknown>} install
 * @param {Record<string, unknown>} vllm
 */
export function renderComposeYaml(install, vllm) {
  const device = normalizeInstallDevice(
    typeof install.device === "string" ? install.device : "cuda",
  );
  const image = resolveImage(install, device);
  const port = hostPort(vllm);
  const cache = hfCacheDir(install);
  const cmdArgs = buildVllmCommandArgs(vllm, device);
  const commandYaml = cmdArgs.map((a) => `      - ${yamlScalar(a)}`).join("\n");

  if (device === "cpu") {
    const kvGb =
      typeof vllm.cpu_kv_cache_space_gb === "number" &&
      Number.isFinite(vllm.cpu_kv_cache_space_gb)
        ? vllm.cpu_kv_cache_space_gb
        : Number(vllm.cpu_kv_cache_space_gb) || 8;
    return `services:
  vllm:
    container_name: vllm
    image: ${image}
    restart: unless-stopped
    shm_size: "4gb"
    ports:
      - "${port}:${port}"
    volumes:
      - ${cache}:/root/.cache/huggingface
    env_file:
      - .env
    environment:
      - HUGGING_FACE_HUB_TOKEN=\${HF_TOKEN}
      - HF_TOKEN=\${HF_TOKEN}
      - VLLM_CPU_KVCACHE_SPACE=${kvGb}
    security_opt:
      - seccomp:unconfined
    cap_add:
      - SYS_NICE
    command:
${commandYaml}
`;
  }

  return `services:
  vllm:
    container_name: vllm
    image: ${image}
    restart: unless-stopped
    ipc: host
    shm_size: "16gb"
    ports:
      - "${port}:${port}"
    volumes:
      - ${cache}:/root/.cache/huggingface
    env_file:
      - .env
    environment:
      - HUGGING_FACE_HUB_TOKEN=\${HF_TOKEN}
      - HF_TOKEN=\${HF_TOKEN}
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    runtime: nvidia
    command:
${commandYaml}
`;
}

/**
 * @param {{ hfToken: string }} secrets
 */
export function renderEnvFile(secrets) {
  const token = String(secrets.hfToken || "").trim();
  return ["# hdc-generated — docker compose", `HF_TOKEN=${token}`, ""].join("\n");
}
