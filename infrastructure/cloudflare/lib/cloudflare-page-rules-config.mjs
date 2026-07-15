/** @typedef {{ operator: string; value: string }} PageRuleTarget */

/** @typedef {{ id: string; value?: unknown }} PageRuleAction */

/**
 * @typedef {object} ConfigPageRule
 * @property {string} id
 * @property {string} [cf_id]
 * @property {number} priority
 * @property {"active" | "disabled"} status
 * @property {PageRuleTarget} target
 * @property {PageRuleAction[]} actions
 */

/**
 * @typedef {object} NormalizedPageRule
 * @property {string} id
 * @property {string} [cf_id]
 * @property {number} priority
 * @property {"active" | "disabled"} status
 * @property {PageRuleTarget} target
 * @property {PageRuleAction[]} actions
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
 * @returns {PageRuleTarget | null}
 */
export function normalizePageRuleTarget(raw) {
  if (!isObject(raw)) return null;
  const operator = strField(raw.operator);
  const value = strField(raw.value);
  if (!operator || !value) return null;
  return { operator, value };
}

/**
 * @param {unknown} raw
 * @returns {PageRuleAction[]}
 */
export function normalizePageRuleActions(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {PageRuleAction[]} */
  const out = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const id = strField(item.id);
    if (!id) continue;
    /** @type {PageRuleAction} */
    const action = { id };
    if (item.value !== undefined) action.value = item.value;
    out.push(action);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {ConfigPageRule | null}
 */
export function configEntryToPageRule(raw) {
  if (!isObject(raw)) return null;
  const id = strField(raw.id);
  const target = normalizePageRuleTarget(raw.target);
  const actions = normalizePageRuleActions(raw.actions);
  if (!id || !target || !actions.length) return null;
  const priority = typeof raw.priority === "number" ? raw.priority : 0;
  const statusRaw = strField(raw.status).toLowerCase();
  const status = statusRaw === "disabled" ? "disabled" : "active";
  const cf_id = strField(raw.cf_id) || undefined;
  return { id, cf_id, priority, status, target, actions };
}

/**
 * @param {ConfigPageRule} rule
 * @returns {NormalizedPageRule}
 */
export function configPageRuleToNormalized(rule) {
  return {
    id: rule.id,
    cf_id: rule.cf_id,
    priority: rule.priority,
    status: rule.status,
    target: { operator: rule.target.operator, value: rule.target.value },
    actions: rule.actions.map((a) => ({ id: a.id, ...(a.value !== undefined ? { value: a.value } : {}) })),
  };
}

/**
 * @param {import('./cloudflare-api.mjs').CfPageRule} live
 * @returns {NormalizedPageRule}
 */
export function livePageRuleToNormalized(live) {
  const targetRaw = live.targets?.[0];
  let target = { operator: "matches", value: "" };
  if (isObject(targetRaw)) {
    const constraint = isObject(targetRaw.constraint) ? targetRaw.constraint : null;
    if (constraint) {
      target = {
        operator: strField(constraint.operator) || "matches",
        value: strField(constraint.value),
      };
    }
  }
  return {
    id: "",
    cf_id: live.id,
    priority: live.priority,
    status: live.status === "disabled" ? "disabled" : "active",
    target,
    actions: normalizePageRuleActions(live.actions),
  };
}

/**
 * @param {NormalizedPageRule} rule
 */
export function pageRuleMatchKey(rule) {
  return `${rule.priority}|${rule.target.operator}|${rule.target.value}`;
}

/**
 * @param {NormalizedPageRule} desired
 * @param {NormalizedPageRule} live
 */
export function pageRulesNeedUpdate(desired, live) {
  if (desired.priority !== live.priority) return true;
  if (desired.status !== live.status) return true;
  if (JSON.stringify(desired.actions) !== JSON.stringify(live.actions)) return true;
  if (desired.target.operator !== live.target.operator) return true;
  if (desired.target.value !== live.target.value) return true;
  return false;
}

/**
 * @param {NormalizedPageRule} rule
 * @returns {Record<string, unknown>}
 */
export function normalizedToPageRuleBody(rule) {
  return {
    targets: [
      {
        target: "url",
        constraint: {
          operator: rule.target.operator,
          value: rule.target.value,
        },
      },
    ],
    actions: rule.actions.map((a) => {
      /** @type {Record<string, unknown>} */
      const out = { id: a.id };
      if (a.value !== undefined) out.value = a.value;
      return out;
    }),
    priority: rule.priority,
    status: rule.status,
  };
}

/**
 * @param {NormalizedPageRule} rule
 * @returns {Record<string, unknown>}
 */
export function normalizedPageRuleToConfigEntry(rule) {
  /** @type {Record<string, unknown>} */
  const entry = {
    id: rule.id,
    priority: rule.priority,
    status: rule.status,
    target: rule.target,
    actions: rule.actions,
  };
  if (rule.cf_id) entry.cf_id = rule.cf_id;
  return entry;
}

/**
 * Slugify a page rule target for import id generation.
 * @param {PageRuleTarget} target
 */
export function slugFromPageRuleTarget(target) {
  const raw = `${target.operator}-${target.value}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return raw || "page-rule";
}
