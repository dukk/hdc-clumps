import { loadMailRelayClientDefaults } from "hdc/package/mail-relay-config.mjs";
import http from "node:http";
import https from "node:https";

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {object} MailcowApiClient
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {(path: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>} request
 */

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @returns {MailcowApiClient}
 */
export function createMailcowApiClient(baseUrl, apiKey) {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl: root,
    apiKey,
    request: (path, opts = {}) => mailcowRequest(root, apiKey, path, opts),
  };
}

/**
 * Minimal fetch-like helper for Mailcow API (supports self-signed HTTPS on LAN).
 * @param {string} url
 * @param {RequestInit} init
 */
function mailcowFetch(url, init) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    /** @type {import("node:https").RequestOptions} */
    const reqOpts = {
      method: init.method ?? "GET",
      headers: init.headers,
      rejectUnauthorized: parsed.protocol === "https:" ? false : undefined,
    };
    const req = lib.request(url, reqOpts, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => body,
        });
      });
    });
    req.on("error", reject);
    if (init.body) req.write(String(init.body));
    req.end();
  });
}

/**
 * @param {string} url
 * @param {RequestInit} init
 */
function fetchWithOptionalInsecureTls(url, init) {
  return mailcowFetch(url, init);
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} path
 * @param {{ method?: string; body?: unknown }} [opts]
 */
export async function mailcowRequest(baseUrl, apiKey, path, opts = {}) {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const url = `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  };
  if (opts.body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetchWithOptionalInsecureTls(url, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    throw new Error(`mailcow API ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return data;
}

/**
 * @param {unknown} response
 */
function apiSuccess(response) {
  if (Array.isArray(response)) {
    const first = response[0];
    if (isObject(first) && first.type === "danger") return false;
    if (isObject(first) && first.type === "error") return false;
    return true;
  }
  return true;
}

/**
 * @param {MailcowApiClient} client
 */
export async function listDomains(client) {
  const data = await client.request("/api/v1/get/domain/all");
  if (!Array.isArray(data)) return [];
  return data.filter(isObject);
}

/**
 * @param {MailcowApiClient} client
 * @param {string} domain
 */
export async function getDkim(client, domain) {
  const data = await client.request(`/api/v1/get/dkim/${encodeURIComponent(domain)}`);
  return isObject(data) ? data : null;
}

/**
 * @param {MailcowApiClient} client
 * @param {string} domain
 * @param {string} selector
 * @param {1024 | 2048} keySize
 */
export async function generateDkim(client, domain, selector, keySize) {
  return client.request("/api/v1/add/dkim", {
    method: "POST",
    body: {
      domains: domain,
      dkim_selector: selector,
      key_size: String(keySize),
    },
  });
}

/**
 * @param {MailcowApiClient} client
 * @param {string} domain
 * @param {Record<string, unknown>} [attrs]
 */
export async function addDomain(client, domain, attrs = {}) {
  const body = {
    active: "1",
    aliases: "400",
    backupmx: "0",
    defquota: "3072",
    description: typeof attrs.description === "string" ? attrs.description : "",
    domain,
    mailboxes: "10",
    maxquota: "10240",
    quota: "10240",
    relay_all_recipients: "0",
    rl_frame: "s",
    rl_value: "10",
    restart_sogo: "1",
    ...attrs,
  };
  const res = await client.request("/api/v1/add/domain", { method: "POST", body });
  if (!apiSuccess(res)) {
    throw new Error(`add domain ${domain} failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 * @param {string} domain
 * @param {Record<string, unknown>} attr
 */
export async function editDomain(client, domain, attr) {
  const res = await client.request("/api/v1/edit/domain", {
    method: "POST",
    body: { items: [domain], attr },
  });
  if (!apiSuccess(res)) {
    throw new Error(`edit domain ${domain} failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 */
export async function listRelayhosts(client) {
  const data = await client.request("/api/v1/get/relayhost/all");
  if (!Array.isArray(data)) return [];
  return data.filter(isObject);
}

/**
 * @param {MailcowApiClient} client
 * @param {string} hostname host:port
 */
export async function addRelayhost(client, hostname) {
  const res = await client.request("/api/v1/add/relayhost", {
    method: "POST",
    body: { hostname, username: "", password: "" },
  });
  if (!apiSuccess(res)) {
    throw new Error(`add relayhost ${hostname} failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 * @param {string} hostname
 */
export async function ensureRelayhostId(client, hostname) {
  const hosts = await listRelayhosts(client);
  const want = hostname.trim().toLowerCase();
  for (const h of hosts) {
    const hn = typeof h.hostname === "string" ? h.hostname.trim().toLowerCase() : "";
    if (hn === want) {
      const id = h.id;
      return id !== undefined && id !== null ? String(id) : null;
    }
  }
  await addRelayhost(client, hostname);
  const after = await listRelayhosts(client);
  for (const h of after) {
    const hn = typeof h.hostname === "string" ? h.hostname.trim().toLowerCase() : "";
    if (hn === want) {
      const id = h.id;
      return id !== undefined && id !== null ? String(id) : null;
    }
  }
  return null;
}

/**
 * @param {import("./mailcow-dns.mjs").MailcowDomainConfig[]} domains
 * @param {MailcowApiClient} client
 * @param {{ log?: (line: string) => void }} [opts]
 */
export async function reconcileMailcowDomains(domains, client, opts = {}) {
  const log = opts.log ?? (() => {});
  const relayDefaults = loadMailRelayClientDefaults();
  const relayHostname = `${relayDefaults.relay_hostname}:${relayDefaults.relay_port}`;

  const existing = await listDomains(client);
  const liveCountBefore = existing.length;
  const byName = new Map(
    existing.map((d) => [
      typeof d.domain_name === "string" ? d.domain_name.trim() : "",
      d,
    ]),
  );

  /** @type {string | null} */
  let relayIdCache = null;

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let addedCount = 0;
  let failedCount = 0;

  for (const domain of domains) {
    const wantDescription = domain.description || `hdc mailcow ${domain.name}`;

    /** @type {Record<string, unknown>} */
    const row = {
      domain: domain.name,
      outbound_mode: domain.outbound_mode,
      domain_added: false,
      description_updated: false,
      dkim_generated: false,
      relayhost_id: null,
      ok: true,
      message: "ok",
    };

    try {
      const live = byName.get(domain.name);
      if (!live) {
        log(`add domain ${domain.name}`);
        await addDomain(client, domain.name, { description: wantDescription });
        row.domain_added = true;
        addedCount += 1;
        byName.set(domain.name, { domain_name: domain.name, description: wantDescription });
      } else {
        const liveDesc =
          typeof live.description === "string" ? live.description.trim() : "";
        if (liveDesc !== wantDescription) {
          log(`update description for ${domain.name}`);
          await editDomain(client, domain.name, { description: wantDescription });
          row.description_updated = true;
        }
      }

      let dkim = await getDkim(client, domain.name);
      const dkimTxt = isObject(dkim) && typeof dkim.dkim_txt === "string" ? dkim.dkim_txt.trim() : "";
      if (!dkimTxt) {
        log(`generate DKIM for ${domain.name} (selector ${domain.dkim_selector})`);
        await generateDkim(client, domain.name, domain.dkim_selector, domain.dkim_key_size);
        row.dkim_generated = true;
        dkim = await getDkim(client, domain.name);
      }
      row.dkim_selector =
        isObject(dkim) && typeof dkim.dkim_selector === "string" ? dkim.dkim_selector : domain.dkim_selector;
      row.dkim_txt =
        isObject(dkim) && typeof dkim.dkim_txt === "string" ? dkim.dkim_txt : null;

      if (domain.outbound_mode === "postfix-relay") {
        if (!relayIdCache) {
          relayIdCache = await ensureRelayhostId(client, relayHostname);
        }
        if (!relayIdCache) {
          throw new Error(`failed to ensure relayhost ${relayHostname}`);
        }
        log(`set relayhost ${relayIdCache} on ${domain.name}`);
        await editDomain(client, domain.name, { relayhost: relayIdCache });
        row.relayhost_id = relayIdCache;
      } else {
        log(`set direct outbound on ${domain.name}`);
        await editDomain(client, domain.name, { relayhost: "0" });
        row.relayhost_id = "0";
      }
      log(`${domain.name}: ok`);
    } catch (e) {
      row.ok = false;
      row.message = String(/** @type {Error} */ (e).message || e);
      failedCount += 1;
      log(`${domain.name}: failed — ${row.message}`);
    }

    results.push(row);
  }

  return {
    domain_results: results,
    summary: {
      configured_count: domains.length,
      live_count_before: liveCountBefore,
      added_count: addedCount,
      failed_count: failedCount,
    },
  };
}

/**
 * @param {MailcowApiClient} client
 */
export async function listMailboxes(client) {
  const data = await client.request("/api/v1/get/mailbox/all");
  if (!Array.isArray(data)) return [];
  return data.filter(isObject);
}

/**
 * @param {MailcowApiClient} client
 * @param {string} address full email
 */
export async function getMailbox(client, address) {
  const data = await client.request("/api/v1/get/mailbox", {
    method: "POST",
    body: { items: [address] },
  });
  if (Array.isArray(data) && isObject(data[0])) return data[0];
  return null;
}

/**
 * @param {MailcowApiClient} client
 * @param {Record<string, unknown>} attrs
 */
export async function addMailbox(client, attrs) {
  const res = await client.request("/api/v1/add/mailbox", {
    method: "POST",
    body: attrs,
  });
  if (!apiSuccess(res)) {
    throw new Error(`add mailbox failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 * @param {string} address
 * @param {Record<string, unknown>} attr
 */
export async function editMailbox(client, address, attr) {
  const res = await client.request("/api/v1/edit/mailbox", {
    method: "POST",
    body: { items: [address], attr },
  });
  if (!apiSuccess(res)) {
    throw new Error(`edit mailbox ${address} failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 * @param {string[]} addresses
 */
export async function deleteMailboxes(client, addresses) {
  if (!addresses.length) return null;
  const res = await client.request("/api/v1/delete/mailbox", {
    method: "POST",
    body: { items: addresses },
  });
  if (!apiSuccess(res)) {
    throw new Error(`delete mailbox failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 */
export async function listAliases(client) {
  const data = await client.request("/api/v1/get/alias/all");
  if (!Array.isArray(data)) return [];
  return data.filter(isObject);
}

/**
 * @param {MailcowApiClient} client
 * @param {Record<string, unknown>} attrs
 */
export async function addAlias(client, attrs) {
  const res = await client.request("/api/v1/add/alias", {
    method: "POST",
    body: attrs,
  });
  if (!apiSuccess(res)) {
    throw new Error(`add alias failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 * @param {string} address
 * @param {Record<string, unknown>} attr
 */
export async function editAlias(client, address, attr) {
  const res = await client.request("/api/v1/edit/alias", {
    method: "POST",
    body: { items: [address], attr },
  });
  if (!apiSuccess(res)) {
    throw new Error(`edit alias ${address} failed`);
  }
  return res;
}

/**
 * @param {MailcowApiClient} client
 * @param {string[]} addresses
 */
export async function deleteAliases(client, addresses) {
  if (!addresses.length) return null;
  const res = await client.request("/api/v1/delete/alias", {
    method: "POST",
    body: { items: addresses },
  });
  if (!apiSuccess(res)) {
    throw new Error(`delete alias failed`);
  }
  return res;
}

/**
 * Normalize mailbox address from live API row.
 * @param {Record<string, unknown>} row
 */
export function mailboxAddressFromRow(row) {
  if (typeof row.username === "string" && row.username.trim()) {
    return row.username.trim().toLowerCase();
  }
  const local =
    typeof row.local_part === "string" ? row.local_part.trim() : "";
  const domain = typeof row.domain === "string" ? row.domain.trim() : "";
  if (local && domain) return `${local}@${domain}`.toLowerCase();
  return "";
}

/**
 * Normalize alias address from live API row.
 * @param {Record<string, unknown>} row
 */
export function aliasAddressFromRow(row) {
  const address = typeof row.address === "string" ? row.address.trim() : "";
  return address.toLowerCase();
}

/**
 * @param {string} gotoRaw
 * @returns {string[]}
 */
export function parseAliasGotoList(gotoRaw) {
  if (!gotoRaw || typeof gotoRaw !== "string") return [];
  return gotoRaw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {import("./mailcow-render.mjs").MailcowMailboxConfig[]} mailboxes
 * @param {MailcowApiClient} client
 * @param {{
 *   log?: (line: string) => void;
 *   prune?: boolean;
 *   rotatePasswords?: boolean;
 *   configuredDomains?: Set<string>;
 *   resolvePassword?: (mailbox: import("./mailcow-render.mjs").MailcowMailboxConfig) => Promise<string | null>;
 * }} [opts]
 */
export async function reconcileMailcowMailboxes(mailboxes, client, opts = {}) {
  const log = opts.log ?? (() => {});
  const existing = await listMailboxes(client);
  const byAddress = new Map(
    existing
      .map((row) => [mailboxAddressFromRow(row), row])
      .filter(([addr]) => Boolean(addr)),
  );

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let addedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;
  let prunedCount = 0;

  const configuredAddresses = new Set(
    mailboxes.map((m) => m.address.toLowerCase()),
  );

  for (const mailbox of mailboxes) {
    const address = mailbox.address.toLowerCase();
    /** @type {Record<string, unknown>} */
    const row = {
      address,
      domain: mailbox.domain,
      local_part: mailbox.local_part,
      mailbox_added: false,
      mailbox_updated: false,
      password_set: false,
      ok: true,
      message: "ok",
    };

    try {
      const live = byAddress.get(address);
      const wantActive = mailbox.active !== false ? "1" : "0";
      const wantQuota = String(mailbox.quota_mb);
      const wantName = mailbox.name || address;

      if (!live) {
        if (!opts.resolvePassword) {
          throw new Error("password resolver required to create mailbox");
        }
        const password = await opts.resolvePassword(mailbox);
        if (!password) {
          throw new Error(
            `missing password for ${address} — set vault ${mailbox.password_vault_key}`,
          );
        }
        log(`add mailbox ${address}`);
        await addMailbox(client, {
          local_part: mailbox.local_part,
          domain: mailbox.domain,
          name: wantName,
          quota: wantQuota,
          password,
          password2: password,
          active: wantActive,
        });
        row.mailbox_added = true;
        row.password_set = true;
        addedCount += 1;
        byAddress.set(address, { username: address });
      } else {
        /** @type {Record<string, unknown>} */
        const attr = {};
        const liveName = typeof live.name === "string" ? live.name.trim() : "";
        const liveQuota =
          live.quota !== undefined && live.quota !== null ? String(live.quota) : "";
        const liveActive =
          live.active !== undefined && live.active !== null ? String(live.active) : "1";

        if (liveName !== wantName) attr.name = wantName;
        if (liveQuota !== wantQuota) attr.quota = wantQuota;
        if (liveActive !== wantActive) attr.active = wantActive;

        if (opts.rotatePasswords && opts.resolvePassword) {
          const password = await opts.resolvePassword(mailbox);
          if (password) {
            attr.password = password;
            attr.password2 = password;
            row.password_set = true;
          }
        }

        if (Object.keys(attr).length) {
          log(`update mailbox ${address}`);
          await editMailbox(client, address, attr);
          row.mailbox_updated = true;
          updatedCount += 1;
        }
      }
      log(`${address}: ok`);
    } catch (e) {
      row.ok = false;
      row.message = String(/** @type {Error} */ (e).message || e);
      failedCount += 1;
      log(`${address}: failed — ${row.message}`);
    }

    results.push(row);
  }

  if (opts.prune) {
    const domainFilter = opts.configuredDomains;
    const extras = [...byAddress.keys()].filter((addr) => {
      if (!addr || configuredAddresses.has(addr)) return false;
      if (!domainFilter || domainFilter.size === 0) return true;
      const domain = addr.split("@")[1] || "";
      return domainFilter.has(domain.toLowerCase());
    });
    if (extras.length) {
      log(`prune ${extras.length} extra mailbox(es): ${extras.join(", ")}`);
      await deleteMailboxes(client, extras);
      prunedCount = extras.length;
    }
  }

  return {
    mailbox_results: results,
    summary: {
      configured_count: mailboxes.length,
      live_count_before: existing.length,
      added_count: addedCount,
      updated_count: updatedCount,
      pruned_count: prunedCount,
      failed_count: failedCount,
    },
  };
}

/**
 * @param {import("./mailcow-render.mjs").MailcowAliasConfig[]} aliases
 * @param {MailcowApiClient} client
 * @param {{ log?: (line: string) => void; prune?: boolean; configuredDomains?: Set<string> }} [opts]
 */
export async function reconcileMailcowAliases(aliases, client, opts = {}) {
  const log = opts.log ?? (() => {});
  const existing = await listAliases(client);
  const byAddress = new Map(
    existing
      .map((row) => [aliasAddressFromRow(row), row])
      .filter(([addr]) => Boolean(addr)),
  );

  /** @type {Record<string, unknown>[]} */
  const results = [];
  let addedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;
  let prunedCount = 0;

  const configuredAddresses = new Set(aliases.map((a) => a.address.toLowerCase()));

  for (const alias of aliases) {
    const address = alias.address.toLowerCase();
    const wantGoto = alias.goto.join(",");
    const wantActive = alias.active !== false ? "1" : "0";

    /** @type {Record<string, unknown>} */
    const row = {
      address,
      alias_added: false,
      alias_updated: false,
      ok: true,
      message: "ok",
    };

    try {
      const live = byAddress.get(address);
      if (!live) {
        log(`add alias ${address} → ${wantGoto}`);
        await addAlias(client, {
          active: wantActive,
          address,
          goto: wantGoto,
        });
        row.alias_added = true;
        addedCount += 1;
        byAddress.set(address, { address, goto: wantGoto });
      } else {
        const liveGoto = typeof live.goto === "string" ? live.goto.trim() : "";
        const liveActive =
          live.active !== undefined && live.active !== null ? String(live.active) : "1";
        /** @type {Record<string, unknown>} */
        const attr = {};
        if (liveGoto !== wantGoto) attr.goto = wantGoto;
        if (liveActive !== wantActive) attr.active = wantActive;
        if (Object.keys(attr).length) {
          log(`update alias ${address}`);
          await editAlias(client, address, attr);
          row.alias_updated = true;
          updatedCount += 1;
        }
      }
      log(`${address}: ok`);
    } catch (e) {
      row.ok = false;
      row.message = String(/** @type {Error} */ (e).message || e);
      failedCount += 1;
      log(`${address}: failed — ${row.message}`);
    }

    results.push(row);
  }

  if (opts.prune) {
    const domainFilter = opts.configuredDomains;
    const extras = [...byAddress.keys()].filter((addr) => {
      if (!addr || configuredAddresses.has(addr)) return false;
      if (!domainFilter || domainFilter.size === 0) return true;
      const domain = addr.split("@")[1] || "";
      return domainFilter.has(domain.toLowerCase());
    });
    if (extras.length) {
      log(`prune ${extras.length} extra alias(es): ${extras.join(", ")}`);
      await deleteAliases(client, extras);
      prunedCount = extras.length;
    }
  }

  return {
    alias_results: results,
    summary: {
      configured_count: aliases.length,
      live_count_before: existing.length,
      added_count: addedCount,
      updated_count: updatedCount,
      pruned_count: prunedCount,
      failed_count: failedCount,
    },
  };
}
