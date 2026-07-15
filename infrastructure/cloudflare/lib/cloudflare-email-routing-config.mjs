/** @typedef {{ type: string; field?: string; value?: string }} EmailRoutingMatcher */

/** @typedef {{ type: string; value?: string[] }} EmailRoutingAction */

/**
 * @typedef {object} ConfigEmailRoutingRule
 * @property {string} id
 * @property {string} [cf_id]
 * @property {string} [name]
 * @property {boolean} enabled
 * @property {number} [priority]
 * @property {EmailRoutingMatcher[]} matchers
 * @property {EmailRoutingAction[]} actions
 */

/**
 * @typedef {object} NormalizedEmailRoutingRule
 * @property {string} id
 * @property {string} [cf_id]
 * @property {string} [name]
 * @property {boolean} enabled
 * @property {number} [priority]
 * @property {EmailRoutingMatcher[]} matchers
 * @property {EmailRoutingAction[]} actions
 */

/**
 * @typedef {object} ConfigEmailRoutingCatchAll
 * @property {boolean} enabled
 * @property {EmailRoutingAction[]} actions
 */

/**
 * @typedef {object} NormalizedEmailRoutingCatchAll
 * @property {boolean} enabled
 * @property {EmailRoutingAction[]} actions
 */

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} v
 */
function strField(v) {
  return typeof v === "string" ? v.trim() : v !== undefined && v !== null ? String(v).trim() : "";
}

/**
 * @param {unknown} raw
 * @returns {EmailRoutingMatcher[]}
 */
export function normalizeEmailRoutingMatchers(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {EmailRoutingMatcher[]} */
  const out = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const type = strField(item.type);
    if (!type) continue;
    /** @type {EmailRoutingMatcher} */
    const matcher = { type };
    const field = strField(item.field);
    const value = strField(item.value);
    if (field) matcher.field = field;
    if (value) matcher.value = value;
    out.push(matcher);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {EmailRoutingAction[]}
 */
export function normalizeEmailRoutingActions(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {EmailRoutingAction[]} */
  const out = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const type = strField(item.type);
    if (!type) continue;
    /** @type {EmailRoutingAction} */
    const action = { type };
    if (Array.isArray(item.value)) {
      action.value = item.value.map((v) => String(v).trim()).filter(Boolean);
    }
    out.push(action);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {ConfigEmailRoutingRule | null}
 */
export function configEntryToEmailRoutingRule(raw) {
  if (!isObject(raw)) return null;
  const id = strField(raw.id);
  const matchers = normalizeEmailRoutingMatchers(raw.matchers);
  const actions = normalizeEmailRoutingActions(raw.actions);
  if (!id || !matchers.length || !actions.length) return null;
  const cf_id = strField(raw.cf_id) || undefined;
  const name = strField(raw.name) || undefined;
  const enabled = raw.enabled !== false;
  const priority = typeof raw.priority === "number" ? raw.priority : undefined;
  return { id, cf_id, name, enabled, priority, matchers, actions };
}

/**
 * @param {ConfigEmailRoutingRule} rule
 * @returns {NormalizedEmailRoutingRule}
 */
export function configEmailRoutingRuleToNormalized(rule) {
  return {
    id: rule.id,
    cf_id: rule.cf_id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    matchers: rule.matchers.map((m) => ({ ...m })),
    actions: rule.actions.map((a) => ({
      type: a.type,
      ...(a.value ? { value: [...a.value] } : {}),
    })),
  };
}

/**
 * @param {import('./cloudflare-api.mjs').CfEmailRoutingRule} live
 * @returns {NormalizedEmailRoutingRule}
 */
export function liveEmailRoutingRuleToNormalized(live) {
  return {
    id: "",
    cf_id: live.id,
    name: live.name,
    enabled: live.enabled,
    priority: live.priority,
    matchers: normalizeEmailRoutingMatchers(live.matchers),
    actions: normalizeEmailRoutingActions(live.actions),
  };
}

/**
 * @param {NormalizedEmailRoutingRule} rule
 */
export function emailRoutingRuleMatchKey(rule) {
  const m = rule.matchers[0];
  if (!m) throw new Error("Email routing rule requires at least one matcher");
  if (m.type !== "literal" || m.field !== "to" || !m.value) {
    throw new Error(
      `Unsupported email routing matcher for sync key: type=${m.type} field=${m.field ?? ""}`
    );
  }
  return `${m.type}|${m.field}|${m.value}`;
}

/**
 * @param {NormalizedEmailRoutingRule} desired
 * @param {NormalizedEmailRoutingRule} live
 */
export function emailRoutingRulesNeedUpdate(desired, live) {
  if (desired.enabled !== live.enabled) return true;
  if ((desired.name ?? "") !== (live.name ?? "")) return true;
  if (desired.priority !== live.priority) return true;
  if (JSON.stringify(desired.matchers) !== JSON.stringify(live.matchers)) return true;
  if (JSON.stringify(desired.actions) !== JSON.stringify(live.actions)) return true;
  return false;
}

/**
 * @param {NormalizedEmailRoutingRule} rule
 * @returns {Record<string, unknown>}
 */
export function normalizedToEmailRoutingRuleBody(rule) {
  /** @type {Record<string, unknown>} */
  const body = {
    enabled: rule.enabled,
    matchers: rule.matchers,
    actions: rule.actions,
  };
  if (rule.name) body.name = rule.name;
  if (typeof rule.priority === "number") body.priority = rule.priority;
  return body;
}

/**
 * @param {NormalizedEmailRoutingRule} rule
 * @returns {Record<string, unknown>}
 */
export function normalizedEmailRoutingRuleToConfigEntry(rule) {
  /** @type {Record<string, unknown>} */
  const entry = {
    id: rule.id,
    enabled: rule.enabled,
    matchers: rule.matchers,
    actions: rule.actions,
  };
  if (rule.cf_id) entry.cf_id = rule.cf_id;
  if (rule.name) entry.name = rule.name;
  if (typeof rule.priority === "number") entry.priority = rule.priority;
  return entry;
}

/**
 * @param {unknown} raw
 * @returns {ConfigEmailRoutingCatchAll | null}
 */
export function configEntryToCatchAll(raw) {
  if (!isObject(raw)) return null;
  const actions = normalizeEmailRoutingActions(raw.actions);
  if (!actions.length) return null;
  return {
    enabled: raw.enabled !== false,
    actions,
  };
}

/**
 * @param {import('./cloudflare-api.mjs').CfEmailRoutingCatchAll | null} live
 * @returns {NormalizedEmailRoutingCatchAll | null}
 */
export function liveCatchAllToNormalized(live) {
  if (!live) return null;
  const actions = normalizeEmailRoutingActions(live.actions);
  if (!actions.length) return null;
  return {
    enabled: live.enabled !== false,
    actions,
  };
}

/**
 * @param {NormalizedEmailRoutingCatchAll} desired
 * @param {NormalizedEmailRoutingCatchAll} live
 */
export function catchAllNeedUpdate(desired, live) {
  if (desired.enabled !== live.enabled) return true;
  if (JSON.stringify(desired.actions) !== JSON.stringify(live.actions)) return true;
  return false;
}

/**
 * @param {NormalizedEmailRoutingCatchAll} catchAll
 * @returns {Record<string, unknown>}
 */
export function normalizedToCatchAllBody(catchAll) {
  return {
    enabled: catchAll.enabled,
    actions: catchAll.actions,
  };
}

/**
 * @param {NormalizedEmailRoutingCatchAll} catchAll
 * @returns {Record<string, unknown>}
 */
export function normalizedCatchAllToConfigEntry(catchAll) {
  return {
    enabled: catchAll.enabled,
    actions: catchAll.actions,
  };
}

/**
 * @param {EmailRoutingMatcher} matcher
 */
export function slugFromEmailRoutingMatcher(matcher) {
  const raw = `${matcher.field ?? "to"}-${matcher.value ?? "all"}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return raw || "email-rule";
}
