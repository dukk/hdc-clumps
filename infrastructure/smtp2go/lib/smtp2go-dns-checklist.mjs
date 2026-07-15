/** @typedef {{
 *   type: "TXT" | "CNAME";
 *   name: string;
 *   data: string;
 *   purpose: string;
 *   verified?: boolean | null;
 * }} DnsChecklistRow */

const DEFAULT_SPF = "v=spf1 include:spf.smtp2go.com ~all";
const MAILCOW_STYLE_SPF = "v=spf1 mx a include:spf.smtp2go.com ~all";

/**
 * @param {import('./smtp2go-api.mjs').Smtp2goSenderDomainRow} row
 * @param {{ spf?: string; dmarc?: string | null; spf_variant?: "default" | "mailcow" }} [opts]
 * @returns {DnsChecklistRow[]}
 */
export function buildDnsChecklist(row, opts = {}) {
  const domain = row?.domain;
  if (!domain || typeof domain.fulldomain !== "string") return [];

  const spf =
    typeof opts.spf === "string" && opts.spf.trim()
      ? opts.spf.trim()
      : opts.spf_variant === "mailcow"
        ? MAILCOW_STYLE_SPF
        : DEFAULT_SPF;

  /** @type {DnsChecklistRow[]} */
  const checklist = [
    {
      type: "TXT",
      name: "@",
      data: spf,
      purpose: "spf",
      verified: null,
    },
  ];

  const dkimSelector =
    typeof domain.dkim_selector === "string" ? domain.dkim_selector.trim() : "";
  const dkimValue = typeof domain.dkim_value === "string" ? domain.dkim_value.trim() : "";
  if (dkimSelector && dkimValue) {
    checklist.push({
      type: "CNAME",
      name: `${dkimSelector}._domainkey`,
      data: dkimValue,
      purpose: "dkim",
      verified: domain.dkim_verified === true,
    });
  }

  const rpathSelector =
    typeof domain.rpath_selector === "string" ? domain.rpath_selector.trim() : "";
  const rpathValue = typeof domain.rpath_value === "string" ? domain.rpath_value.trim() : "";
  if (rpathSelector && rpathValue) {
    checklist.push({
      type: "CNAME",
      name: rpathSelector,
      data: rpathValue,
      purpose: "return_path",
      verified: domain.rpath_verified === true,
    });
  }

  const trackers = Array.isArray(row.trackers) ? row.trackers : [];
  for (const tracker of trackers) {
    const sub = typeof tracker.subdomain === "string" ? tracker.subdomain.trim() : "";
    const cnameValue =
      typeof tracker.cname_value === "string" && tracker.cname_value.trim()
        ? tracker.cname_value.trim()
        : "track.smtp2go.net";
    if (!sub) continue;
    checklist.push({
      type: "CNAME",
      name: sub,
      data: cnameValue,
      purpose: "tracking",
      verified: tracker.cname_verified === true,
    });
  }

  if (typeof opts.dmarc === "string" && opts.dmarc.trim()) {
    checklist.push({
      type: "TXT",
      name: "_dmarc",
      data: opts.dmarc.trim(),
      purpose: "dmarc_reminder",
      verified: null,
    });
  }

  return checklist;
}

/**
 * @param {import('./smtp2go-api.mjs').Smtp2goSenderDomainRow} row
 */
export function domainVerificationSummary(row) {
  const domain = row?.domain ?? {};
  const trackers = Array.isArray(row.trackers) ? row.trackers : [];
  const trackingVerified =
    trackers.length === 0 ? null : trackers.every((t) => t.cname_verified === true);

  return {
    dkim_verified: domain.dkim_verified === true,
    rpath_verified: domain.rpath_verified === true,
    tracking_verified: trackingVerified,
    fully_verified:
      domain.dkim_verified === true &&
      domain.rpath_verified === true &&
      (trackingVerified === null || trackingVerified === true),
  };
}
