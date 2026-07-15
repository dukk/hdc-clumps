import { domainVerificationSummary } from "./smtp2go-dns-checklist.mjs";
import { resolveDomainAddOptions } from "./smtp2go-config.mjs";

/**
 * @typedef {import('./smtp2go-config.mjs').ConfigSenderDomain} ConfigSenderDomain
 * @typedef {import('./smtp2go-api.mjs').Smtp2goSenderDomainRow} Smtp2goSenderDomainRow
 */

/**
 * @param {object} opts
 * @param {ConfigSenderDomain} opts.entry
 * @param {Smtp2goSenderDomainRow | null} opts.live
 * @param {ReturnType<import('./smtp2go-config.mjs').normalizeSmtp2goConfig>["defaults"]} opts.defaults
 */
export function planDomainSync(opts) {
  const { entry, live, defaults } = opts;

  if (!entry.managed) {
    return {
      action: /** @type {"skip"} */ ("skip"),
      domainId: entry.id,
      domain: entry.domain,
      reason: "not managed",
      unchanged: true,
    };
  }

  if (!live) {
    const addOpts = resolveDomainAddOptions(entry, defaults);
    return {
      action: /** @type {"add"} */ ("add"),
      domainId: entry.id,
      domain: entry.domain,
      addOpts,
      unchanged: false,
    };
  }

  const verification = domainVerificationSummary(live);
  if (!verification.fully_verified) {
    return {
      action: /** @type {"verify"} */ ("verify"),
      domainId: entry.id,
      domain: entry.domain,
      verification,
      unchanged: false,
    };
  }

  return {
    action: /** @type {"unchanged"} */ ("unchanged"),
    domainId: entry.id,
    domain: entry.domain,
    verification,
    unchanged: true,
  };
}

/**
 * @param {ReturnType<import('./smtp2go-api.mjs').createSmtp2goClient>} api
 * @param {ReturnType<typeof planDomainSync>} plan
 * @param {{ dryRun?: boolean; log?: (line: string) => void; skipVerify?: boolean }} [opts]
 */
export async function applyDomainSync(api, plan, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const skipVerify = Boolean(opts.skipVerify);
  const log = opts.log ?? (() => {});

  if (plan.action === "skip") {
    log(`skip ${plan.domain} (${plan.reason})`);
    return { ok: true, action: "skip", domainId: plan.domainId, domain: plan.domain };
  }

  if (plan.action === "unchanged") {
    log(`unchanged ${plan.domain}`);
    return {
      ok: true,
      action: "unchanged",
      domainId: plan.domainId,
      domain: plan.domain,
      verification: plan.verification,
    };
  }

  if (plan.action === "add") {
    try {
      if (dryRun) {
        log(`dry-run: would add sender domain ${plan.domain}`);
        return { ok: true, action: "add", domainId: plan.domainId, domain: plan.domain, dryRun: true };
      }
      await api.addSenderDomain({
        domain: plan.domain,
        trackingSubdomain: plan.addOpts.trackingSubdomain,
        returnpathSubdomain: plan.addOpts.returnpathSubdomain,
        autoVerify: plan.addOpts.autoVerify,
      });
      log(`added sender domain ${plan.domain}`);
      if (!plan.addOpts.autoVerify && !skipVerify) {
        await api.verifySenderDomain(plan.domain);
        log(`verify requested for ${plan.domain}`);
      }
      return { ok: true, action: "add", domainId: plan.domainId, domain: plan.domain };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed add ${plan.domain}: ${msg}`);
      return { ok: false, action: "add", domainId: plan.domainId, domain: plan.domain, error: msg };
    }
  }

  if (plan.action === "verify") {
    if (skipVerify) {
      log(`skip verify ${plan.domain} (--skip-verify)`);
      return {
        ok: true,
        action: "verify_skipped",
        domainId: plan.domainId,
        domain: plan.domain,
        verification: plan.verification,
      };
    }
    try {
      if (dryRun) {
        log(`dry-run: would verify sender domain ${plan.domain}`);
        return {
          ok: true,
          action: "verify",
          domainId: plan.domainId,
          domain: plan.domain,
          dryRun: true,
        };
      }
      await api.verifySenderDomain(plan.domain);
      log(`verify requested for ${plan.domain}`);
      return { ok: true, action: "verify", domainId: plan.domainId, domain: plan.domain };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`failed verify ${plan.domain}: ${msg}`);
      return { ok: false, action: "verify", domainId: plan.domainId, domain: plan.domain, error: msg };
    }
  }

  return { ok: true, action: "unknown", domainId: plan.domainId, domain: plan.domain };
}
