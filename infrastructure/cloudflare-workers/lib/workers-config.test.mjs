import { describe, expect, it } from "vitest";

import {
  normalizeCloudflareWorkersConfig,
  routeMatchKey,
  workerPassesFilter,
  zonePassesFilter,
} from "./workers-config.mjs";

describe("workers-config", () => {
  it("normalizes workers and pages with account id from env", () => {
    const cfg = normalizeCloudflareWorkersConfig({
      schema_version: 1,
      cloudflare_workers: {
        account_id: "acc-123",
        wrangler: { binary: "wrangler" },
      },
      workers: [
        {
          id: "mailer",
          managed: true,
          project_dir: "workers/mailer",
          script_name: "waitlist-mailer",
          routes: [{ pattern: "api.example.com/*", zone_name: "example.com" }],
          secrets: [{ name: "API_KEY", vault_key: "HDC_TEST_KEY" }],
        },
      ],
      pages: [
        {
          id: "site",
          project_name: "my-site",
          deploy_dir: "dist",
        },
      ],
    });

    expect(cfg.accountId).toBe("acc-123");
    expect(cfg.workers).toHaveLength(1);
    expect(cfg.workers[0].script_name).toBe("waitlist-mailer");
    expect(cfg.pages[0].project_name).toBe("my-site");
    expect(cfg.pages[0].deploy_dir).toBe("dist");
  });

  it("throws when account id is missing", () => {
    expect(() =>
      normalizeCloudflareWorkersConfig({ schema_version: 1, workers: [], pages: [] })
    ).toThrow(/account_id/);
  });

  it("filters managed workers by id", () => {
    const worker = {
      id: "a",
      managed: true,
      project_dir: "workers/a",
      script_name: "a",
      wrangler_env: null,
      npm_install: true,
      routes: [],
      secrets: [],
    };
    expect(workerPassesFilter(worker, "a")).toBe(true);
    expect(workerPassesFilter(worker, "b")).toBe(false);
    expect(workerPassesFilter({ ...worker, managed: false }, null)).toBe(false);
  });

  it("zone filter include/exclude", () => {
    const include = { mode: "include", names: new Set(["example.invalid"]) };
    expect(zonePassesFilter("example.invalid", include)).toBe(true);
    expect(zonePassesFilter("other.com", include)).toBe(false);
    const exclude = { mode: "exclude", names: new Set(["example.invalid"]) };
    expect(zonePassesFilter("example.invalid", exclude)).toBe(false);
  });

  it("routeMatchKey is stable", () => {
    expect(routeMatchKey({ pattern: "a.com/*", zone_name: "a.com" }, "script-a")).toBe(
      "a.com|a.com/*|script-a"
    );
  });
});
