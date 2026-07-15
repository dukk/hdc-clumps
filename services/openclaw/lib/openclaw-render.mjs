/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} openclaw
 */
export function gatewayTokenVaultKey(openclaw) {
  const key =
    typeof openclaw.gateway_token_vault_key === "string" && openclaw.gateway_token_vault_key.trim()
      ? openclaw.gateway_token_vault_key.trim()
      : "HDC_OPENCLAW_GATEWAY_TOKEN";
  return key;
}

/**
 * @param {Record<string, unknown>} openclaw
 */
export function gatewayPort(openclaw) {
  const gw = isObject(openclaw.gateway) ? openclaw.gateway : {};
  const p = typeof gw.port === "number" ? gw.port : Number(gw.port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.trunc(p);
  return 18789;
}

/**
 * @param {Record<string, unknown>} openclaw
 * @returns {"loopback" | "lan"}
 */
export function gatewayBind(openclaw) {
  const gw = isObject(openclaw.gateway) ? openclaw.gateway : {};
  const raw = typeof gw.bind === "string" ? gw.bind.trim().toLowerCase() : "loopback";
  if (raw === "lan") return "lan";
  return "loopback";
}

/**
 * @param {Record<string, unknown>} openclaw
 */
export function openclawVersion(openclaw) {
  const v = typeof openclaw.version === "string" ? openclaw.version.trim() : "";
  return v || "latest";
}

/**
 * @param {Record<string, unknown>} openclaw
 */
export function normalizeEnvSecretEntries(openclaw) {
  const raw = openclaw.env_secrets;
  if (!Array.isArray(raw)) return [];
  /** @type {{ vaultKey: string; guestEnv: string; optional: boolean }[]} */
  const out = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const vaultKey = typeof item.vault_key === "string" ? item.vault_key.trim() : "";
    const guestEnv = typeof item.guest_env === "string" ? item.guest_env.trim() : "";
    if (!vaultKey || !guestEnv) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(vaultKey) || !/^[A-Z_][A-Z0-9_]*$/.test(guestEnv)) {
      throw new Error(`openclaw.env_secrets invalid vault_key/guest_env: ${vaultKey} / ${guestEnv}`);
    }
    out.push({ vaultKey, guestEnv, optional: item.optional === true });
  }
  return out;
}

/**
 * Deep-merge plain objects (arrays replaced).
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function deepMergeObjects(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (isObject(val) && isObject(target[key])) {
      deepMergeObjects(/** @type {Record<string, unknown>} */ (target[key]), val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/**
 * Build openclaw.json object (strict JSON for push to guest).
 * @param {Record<string, unknown>} openclaw
 */
export function renderOpenclawConfigObject(openclaw) {
  const cfg = isObject(openclaw) ? openclaw : {};
  const port = gatewayPort(cfg);
  const bind = gatewayBind(cfg);

  /** @type {Record<string, unknown>} */
  const doc = {
    gateway: {
      mode: "local",
      bind,
      port,
      auth: {
        token: "${OPENCLAW_GATEWAY_TOKEN}",
      },
    },
  };

  if (isObject(cfg.agents)) {
    doc.agents = structuredClone(cfg.agents);
  }

  if (isObject(cfg.channels) && Object.keys(cfg.channels).length > 0) {
    doc.channels = structuredClone(cfg.channels);
  }

  if (isObject(cfg.config_extra) && Object.keys(cfg.config_extra).length > 0) {
    deepMergeObjects(doc, structuredClone(cfg.config_extra));
  }

  return doc;
}

/**
 * @param {Record<string, unknown>} openclaw
 */
export function renderOpenclawJson(openclaw) {
  return `${JSON.stringify(renderOpenclawConfigObject(openclaw), null, 2)}\n`;
}

/**
 * @param {Record<string, string>} secretValues keyed by guest env name
 */
export function renderOpenclawEnvFile(secretValues) {
  const lines = [];
  for (const [key, val] of Object.entries(secretValues)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`invalid guest env name: ${key}`);
    }
    const safe = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
    lines.push(`${key}="${safe}"`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Record<string, unknown>} openclaw
 * @param {string | null} [guestIp]
 */
export function resolveDashboardUrl(openclaw, guestIp = null) {
  const port = gatewayPort(openclaw);
  const bind = gatewayBind(openclaw);
  if (bind === "loopback") {
    const ip = typeof guestIp === "string" && guestIp.trim() ? guestIp.trim() : "<vm-ip>";
    return {
      gateway_url: `http://127.0.0.1:${port}`,
      access_note: `SSH tunnel: ssh -L ${port}:127.0.0.1:${port} hdc@${ip}`,
    };
  }
  const ip = typeof guestIp === "string" && guestIp.trim() ? guestIp.trim() : "<vm-ip>";
  return {
    gateway_url: `http://${ip}:${port}`,
    access_note: `Gateway bound to LAN on port ${port}`,
  };
}

/**
 * Shell-safe single-quoted string for bash.
 * @param {string} s
 */
export function shellQuoteSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
