import { describe, expect, it } from "vitest";

import {
  allowedSendersDrift,
  domainIdFromFqdn,
  ipAllowListDrift,
  liveDomainToConfig,
  liveIpAllowListToConfig,
  normalizeSmtp2goConfig,
  resolveDomainAddOptions,
} from "./smtp2go-config.mjs";
import { collectSmtp2goState } from "./smtp2go-collect.mjs";
import { liveStateToRestrictions } from "./smtp2go-import-restrictions.mjs";

describe("smtp2go-config", () => {
  it("domainIdFromFqdn slugifies fqdn", () => {
    expect(domainIdFromFqdn("hdc.example.invalid")).toBe("hdc-example-invalid");
  });

  it("normalizeSmtp2goConfig reads sender_domains, restrictions, and defaults", () => {
    const cfg = normalizeSmtp2goConfig({
      schema_version: 1,
      smtp2go: {},
      defaults: { tracking_subdomain: "link", auto_verify: true },
      sender_domains: [
        {
          id: "hdc-example-invalid",
          domain: "hdc.example.invalid",
          managed: true,
          tracking_subdomain: "link",
        },
      ],
      ip_allow_list: {
        managed: true,
        enabled: true,
        entries: [{ ip_address: "203.0.113.10/32", description: "relay" }],
      },
      allowed_senders: {
        managed: false,
        mode: "disabled",
        senders: ["noreply@example.com"],
      },
    });
    expect(cfg.senderDomains).toHaveLength(1);
    expect(cfg.defaults.tracking_subdomain).toBe("link");
    expect(cfg.ipAllowList.managed).toBe(true);
    expect(cfg.ipAllowList.entries[0].ip_address).toBe("203.0.113.10");
    expect(cfg.allowedSenders.mode).toBe("disabled");
  });

  it("liveDomainToConfig preserves managed flag and notes from existing entry", () => {
    const row = {
      domain: {
        fulldomain: "example.invalid",
        rpath_selector: "em1160987",
        dkim_selector: "s1160987",
      },
      trackers: [{ subdomain: "link", enabled: true }],
    };
    const existing = {
      id: "example-invalid",
      domain: "example.invalid",
      managed: true,
      tracking_subdomain: "link",
      returnpath_subdomain: null,
      notes: "primary",
      dmarc: null,
      spf: null,
      spf_variant: null,
    };
    const next = liveDomainToConfig(row, existing);
    expect(next.managed).toBe(true);
    expect(next.notes).toBe("primary");
    expect(next.returnpath_subdomain).toBe("em1160987");
  });

  it("liveIpAllowListToConfig preserves managed and descriptions", () => {
    const next = liveIpAllowListToConfig(
      {
        enabled: true,
        ip_addresses: [{ ip_address: "203.0.113.10/32", description: "live desc" }],
      },
      {
        managed: true,
        enabled: false,
        entries: [{ ip_address: "203.0.113.10", description: "config desc" }],
      }
    );
    expect(next.managed).toBe(true);
    expect(next.enabled).toBe(true);
    expect(next.entries[0].description).toBe("config desc");
  });

  it("ipAllowListDrift detects missing live IP", () => {
    const drift = ipAllowListDrift(
      {
        managed: true,
        enabled: true,
        entries: [{ ip_address: "203.0.113.10", description: null }],
      },
      { enabled: true, ip_addresses: [] }
    );
    expect(drift.has_drift).toBe(true);
    expect(drift.missing_in_live).toEqual(["203.0.113.10"]);
  });

  it("allowedSendersDrift detects mode mismatch", () => {
    const drift = allowedSendersDrift(
      { managed: true, mode: "disabled", senders: [] },
      { mode: "whitelist", allowed_senders: [] }
    );
    expect(drift.has_drift).toBe(true);
    expect(drift.mode_drift).toBe(true);
  });

  it("liveStateToRestrictions preserves section managed flags", () => {
    const restrictions = liveStateToRestrictions(
      {
        ipAllowList: { enabled: false, ip_addresses: [] },
        allowedSenders: { mode: "disabled", allowed_senders: [] },
      },
      {
        schema_version: 1,
        smtp2go: {},
        sender_domains: [],
        ip_allow_list: { managed: true, enabled: false, entries: [] },
        allowed_senders: { managed: true, mode: "disabled", senders: [] },
      }
    );
    expect(restrictions.ip_allow_list.managed).toBe(true);
    expect(restrictions.allowed_senders.managed).toBe(true);
  });

  it("resolveDomainAddOptions merges entry with defaults", () => {
    const entry = {
      id: "x",
      domain: "example.com",
      managed: true,
      tracking_subdomain: null,
      returnpath_subdomain: null,
      notes: null,
      dmarc: null,
      spf: null,
      spf_variant: null,
    };
    const opts = resolveDomainAddOptions(entry, {
      tracking_subdomain: "link",
      returnpath_subdomain: null,
      auto_verify: false,
    });
    expect(opts.trackingSubdomain).toBe("link");
  });
});

describe("smtp2go-collect", () => {
  const baseConfig = normalizeSmtp2goConfig({
    schema_version: 1,
    smtp2go: {},
    sender_domains: [
      {
        id: "hdc-example-invalid",
        domain: "hdc.example.invalid",
        managed: true,
      },
      {
        id: "example-invalid",
        domain: "example.invalid",
        managed: false,
      },
    ],
  });

  const liveFixture = {
    senderDomains: [
      {
        domain: {
          fulldomain: "example.invalid",
          dkim_selector: "s1160987",
          dkim_value: "dkim.smtp2go.net",
          dkim_verified: true,
          rpath_selector: "em1160987",
          rpath_value: "return.smtp2go.net",
          rpath_verified: true,
        },
        trackers: [
          {
            subdomain: "link",
            cname_value: "track.smtp2go.net",
            cname_verified: true,
            enabled: true,
          },
        ],
      },
    ],
    ipAllowList: { enabled: false, ip_addresses: [] },
    allowedSenders: { mode: "disabled", allowed_senders: [] },
  };

  it("collectSmtp2goState reports missing configured domain in live", () => {
    const state = collectSmtp2goState({ config: baseConfig, live: liveFixture });
    expect(state.has_drift).toBe(true);
    const hdc = state.sender_domains.find((d) => d.domain === "hdc.example.invalid");
    expect(hdc?.missing_in_live).toBe(true);
    expect(state.extra_in_live).toHaveLength(0);
  });

  it("collectSmtp2goState reports extra live domain", () => {
    const cfg = normalizeSmtp2goConfig({
      schema_version: 1,
      smtp2go: {},
      sender_domains: [],
    });
    const state = collectSmtp2goState({ config: cfg, live: liveFixture });
    expect(state.extra_in_live).toHaveLength(1);
    expect(state.extra_in_live[0].domain).toBe("example.invalid");
  });
});
