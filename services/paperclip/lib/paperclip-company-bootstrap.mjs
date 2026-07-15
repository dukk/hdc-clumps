import { stderr as errout } from "node:process";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function resolvePaperclipCompanyConfig(cfg) {
  const defaults = isObject(cfg.defaults) ? cfg.defaults : {};
  const paperclip = isObject(defaults.paperclip) ? defaults.paperclip : {};
  const company = isObject(paperclip.company) ? paperclip.company : {};
  const agentsRaw = Array.isArray(company.agents) ? company.agents : [];
  /** @type {Record<string, unknown>[]} */
  const agents = agentsRaw.filter(isObject);

  const skillSlugs = [
    "hdc-agent-team",
    "hdc-monitor",
    "hdc-sre",
    "hdc-security",
  ];

  return {
    name: typeof company.name === "string" && company.name.trim() ? company.name.trim() : "Home Data Center",
    api_url: typeof company.api_url === "string" ? company.api_url.trim().replace(/\/$/, "") : "",
    api_key_vault_key:
      typeof company.api_key_vault_key === "string" && company.api_key_vault_key.trim()
        ? company.api_key_vault_key.trim()
        : "HDC_PAPERCLIP_API_KEY",
    company_id: typeof company.company_id === "string" ? company.company_id.trim() : "",
    hdc_web_url:
      typeof company.hdc_web_url === "string"
        ? company.hdc_web_url.trim().replace(/\/$/, "")
        : typeof company.hdc_runner_url === "string"
          ? company.hdc_runner_url.trim().replace(/\/$/, "")
          : "",
    skills_github_base:
      typeof company.skills_github_base === "string" ? company.skills_github_base.trim().replace(/\/$/, "") : "",
    skill_slugs: skillSlugs,
    agents,
  };
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} path
 * @param {{ method?: string; body?: unknown }} [opts]
 */
async function paperclipFetch(baseUrl, apiKey, path, opts = {}) {
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  /** @type {RequestInit} */
  const init = {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  };
  if (opts.body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} companyName
 * @param {string} [configuredId]
 */
async function resolveCompanyId(baseUrl, apiKey, companyName, configuredId) {
  if (configuredId) {
    const probe = await paperclipFetch(baseUrl, apiKey, `/api/companies/${encodeURIComponent(configuredId)}`);
    if (probe.ok) return { companyId: configuredId, created: false };
  }

  const list = await paperclipFetch(baseUrl, apiKey, "/api/companies");
  if (!list.ok) {
    throw new Error(`list companies failed: HTTP ${list.status} ${JSON.stringify(list.data)}`);
  }

  /** @type {unknown[]} */
  const companies = Array.isArray(list.data)
    ? list.data
    : Array.isArray(list.data?.companies)
      ? list.data.companies
      : [];

  for (const row of companies) {
    if (!isObject(row)) continue;
    const id = String(row.id ?? "");
    const name = String(row.name ?? "").trim();
    if (name.toLowerCase() === companyName.toLowerCase()) {
      return { companyId: id, created: false };
    }
  }

  if (companies.length === 1 && isObject(companies[0])) {
    const only = /** @type {Record<string, unknown>} */ (companies[0]);
    return { companyId: String(only.id ?? ""), created: false, note: "single company in tenant" };
  }

  const created = await paperclipFetch(baseUrl, apiKey, "/api/companies", {
    method: "POST",
    body: { name: companyName },
  });
  if (!created.ok) {
    throw new Error(`create company failed: HTTP ${created.status} ${JSON.stringify(created.data)}`);
  }
  const id = String(created.data?.id ?? created.data?.company?.id ?? "");
  if (!id) throw new Error("create company returned no id");
  return { companyId: id, created: true };
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} companyId
 * @param {string} skillsBase
 * @param {string[]} skillSlugs
 * @param {boolean} dryRun
 */
async function importCompanySkills(baseUrl, apiKey, companyId, skillsBase, skillSlugs, dryRun) {
  /** @type {Record<string, unknown>[]} */
  const imported = [];

  const existing = await paperclipFetch(baseUrl, apiKey, `/api/companies/${companyId}/skills`);
  /** @type {Set<string>} */
  const existingSlugs = new Set();
  if (existing.ok) {
    const rows = Array.isArray(existing.data)
      ? existing.data
      : Array.isArray(existing.data?.skills)
        ? existing.data.skills
        : [];
    for (const row of rows) {
      if (isObject(row) && row.slug) existingSlugs.add(String(row.slug));
    }
  }

  for (const slug of skillSlugs) {
    if (existingSlugs.has(slug)) {
      imported.push({ slug, skipped: true, reason: "already installed" });
      continue;
    }
    const source = `${skillsBase}/${slug}`;
    if (dryRun) {
      imported.push({ slug, dry_run: true, source });
      continue;
    }
    const res = await paperclipFetch(baseUrl, apiKey, `/api/companies/${companyId}/skills/import`, {
      method: "POST",
      body: { source },
    });
    imported.push({
      slug,
      ok: res.ok,
      status: res.status,
      source,
      data: res.data,
    });
    if (!res.ok) {
      errout.write(`[hdc] paperclip bootstrap: skill import ${slug} failed HTTP ${res.status}\n`);
    }
  }
  return imported;
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} companyId
 */
async function listCompanyAgents(baseUrl, apiKey, companyId) {
  const res = await paperclipFetch(baseUrl, apiKey, `/api/companies/${companyId}/agents`);
  if (!res.ok) return [];
  const rows = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.agents) ? res.data.agents : [];
  return rows.filter(isObject);
}

/**
 * @param {Record<string, unknown>} agentCfg
 */
function agentDesiredSkills(agentCfg) {
  const raw = Array.isArray(agentCfg.desired_skills) ? agentCfg.desired_skills : [];
  const skills = raw.map((s) => String(s).trim()).filter(Boolean);
  if (!skills.includes("paperclip")) skills.unshift("paperclip");
  return skills;
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} companyId
 * @param {Record<string, unknown>[]} agentConfigs
 * @param {boolean} dryRun
 */
async function ensureCompanyAgents(baseUrl, apiKey, companyId, agentConfigs, dryRun) {
  const live = await listCompanyAgents(baseUrl, apiKey, companyId);
  /** @type {Map<string, Record<string, unknown>>} */
  const byName = new Map();
  for (const row of live) {
    const name = String(row.name ?? "").trim().toLowerCase();
    if (name) byName.set(name, row);
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const cfg of agentConfigs) {
    const id = String(cfg.id ?? "").trim();
    const name = String(cfg.name ?? id).trim();
    const role = String(cfg.role ?? "operator").trim();
    const adapterType = String(cfg.adapter_type ?? "cursor").trim();
    const desiredSkills = agentDesiredSkills(cfg);
    const existing = byName.get(name.toLowerCase());

    if (existing) {
      const agentId = String(existing.id ?? "");
      if (dryRun) {
        results.push({ id, name, agent_id: agentId, dry_run: true, action: "skills-sync" });
        continue;
      }
      const sync = await paperclipFetch(baseUrl, apiKey, `/api/agents/${agentId}/skills/sync`, {
        method: "POST",
        body: { desiredSkills },
      });
      results.push({
        id,
        name,
        agent_id: agentId,
        action: "skills-sync",
        ok: sync.ok,
        status: sync.status,
        desired_skills: desiredSkills,
      });
      continue;
    }

    /** @type {Record<string, unknown>} */
    const body = {
      name,
      role,
      adapterType,
      desiredSkills,
    };
    if (isObject(cfg.adapter_config)) {
      body.adapterConfig = cfg.adapter_config;
    }

    if (dryRun) {
      results.push({ id, name, dry_run: true, action: "create", body });
      continue;
    }

    const created = await paperclipFetch(baseUrl, apiKey, `/api/companies/${companyId}/agents`, {
      method: "POST",
      body,
    });
    results.push({
      id,
      name,
      action: "create",
      ok: created.ok,
      status: created.status,
      agent_id: String(created.data?.id ?? created.data?.agent?.id ?? ""),
      desired_skills: desiredSkills,
      data: created.data,
    });
  }

  return results;
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.cfg
 * @param {string} opts.apiKey
 * @param {boolean} [opts.dryRun]
 */
export async function bootstrapPaperclipCompany(opts) {
  const companyCfg = resolvePaperclipCompanyConfig(opts.cfg);
  if (!companyCfg.api_url) {
    throw new Error("paperclip.company.api_url is required for bootstrap");
  }
  if (!opts.apiKey?.trim()) {
    throw new Error(`missing vault secret ${companyCfg.api_key_vault_key}`);
  }
  if (!companyCfg.skills_github_base) {
    throw new Error("paperclip.company.skills_github_base is required (GitHub tree URL to skills/)");
  }

  const dryRun = opts.dryRun === true;
  const apiKey = opts.apiKey.trim();

  errout.write(`[hdc] paperclip bootstrap: health check ${companyCfg.api_url} …\n`);
  const health = await paperclipFetch(companyCfg.api_url, apiKey, "/api/health");
  if (!health.ok) {
    throw new Error(`paperclip health failed: HTTP ${health.status}`);
  }

  const { companyId, created, note } = await resolveCompanyId(
    companyCfg.api_url,
    apiKey,
    companyCfg.name,
    companyCfg.company_id,
  );
  errout.write(
    `[hdc] paperclip bootstrap: company ${companyId}${created ? " (created)" : ""}${note ? ` (${note})` : ""}\n`,
  );

  const skills = await importCompanySkills(
    companyCfg.api_url,
    apiKey,
    companyId,
    companyCfg.skills_github_base,
    companyCfg.skill_slugs,
    dryRun,
  );

  const agents = await ensureCompanyAgents(
    companyCfg.api_url,
    apiKey,
    companyId,
    companyCfg.agents,
    dryRun,
  );

  return {
    ok: true,
    dry_run: dryRun,
    company_id: companyId,
    company_name: companyCfg.name,
    company_created: created === true,
    api_url: companyCfg.api_url,
    hdc_web_url: companyCfg.hdc_web_url,
    skills,
    agents,
    next_steps: [
      "Bind Paperclip company secrets HDC_WEB_API_URL and HDC_WEB_API_TOKEN (hdc-web-server on hdc-agents-a :9120)",
      "Assign test issue: Run uptime-kuma live query via hdc-web-server / agent fleet",
      "Verify job at hdc-web-server /api/jobs",
    ],
  };
}
