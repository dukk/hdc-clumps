import { describe, expect, it } from "vitest";

import {
  appsNeedUpdate,
  configAppToDesired,
  configAppToManifest,
  liveManifestToNormalized,
  normalizeSlackConfig,
  resolveAppManifestUrls,
  resolveInteractivityRequestUrl,
} from "./slack-config.mjs";
import { planAppSync } from "./slack-sync.mjs";

describe("slack-config", () => {
  it("normalizes managed hdc app", () => {
    const cfg = normalizeSlackConfig({
      schema_version: 1,
      apps: [
        {
          id: "hdc",
          managed: true,
          display_name: "HDC Ops",
          bot_scopes: ["chat:write"],
          match: { app_id: "A123" },
          interactivity: {
            enabled: true,
            derive_from: { hdc_agents_public_url: true, path: "/api/slack/interactions" },
          },
        },
      ],
    });
    expect(cfg.managedApps).toHaveLength(1);
    expect(cfg.managedApps[0].vault.signing_secret_key).toContain("HDC_SLACK_HDC");
    expect(
      resolveInteractivityRequestUrl(cfg.managedApps[0], {
        hdcAgentsPublicUrl: "https://agents.example.invalid",
      }),
    ).toBe("https://agents.example.invalid/api/slack/interactions");
  });

  it("includes background_color in manifest when icon configured", () => {
    const cfg = normalizeSlackConfig({
      apps: [
        {
          id: "hdc",
          managed: true,
          display_name: "HDC Ops",
          icon: { repo_path: "assets/beetle-agent-no-bg.png", background_color: "#0a0a0a" },
        },
      ],
    });
    const manifest = configAppToManifest(cfg.managedApps[0]);
    expect(manifest.display_information.background_color).toBe("#0a0a0a");
  });

  it("builds events and slash command into manifest", () => {
    const cfg = normalizeSlackConfig({
      apps: [
        {
          id: "hdc",
          managed: true,
          display_name: "HDC Ops",
          bot_scopes: [
            "app_mentions:read",
            "chat:write",
            "commands",
            "im:history",
            "users:read",
          ],
          event_subscriptions: {
            enabled: true,
            derive_from: { hdc_agents_public_url: true, path: "/api/slack/events" },
            bot_events: ["app_mention", "message.im"],
          },
          slash_commands: [
            {
              command: "/hdc",
              description: "Ask the HDC manager agent",
              derive_from: { hdc_agents_public_url: true, path: "/api/slack/commands" },
            },
          ],
        },
      ],
    });
    const app = cfg.managedApps[0];
    const urls = resolveAppManifestUrls(app, {
      hdcAgentsPublicUrl: "https://hdc.example.invalid",
    });
    expect(urls.eventsRequestUrl).toBe("https://hdc.example.invalid/api/slack/events");
    expect(urls.slashCommands[0]).toEqual({
      command: "/hdc",
      description: "Ask the HDC manager agent",
      url: "https://hdc.example.invalid/api/slack/commands",
    });
    const manifest = configAppToManifest(app, urls);
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: "https://hdc.example.invalid/api/slack/events",
      bot_events: ["app_mention", "message.im"],
    });
    expect(manifest.features.slash_commands).toEqual([
      {
        command: "/hdc",
        description: "Ask the HDC manager agent",
        url: "https://hdc.example.invalid/api/slack/commands",
        should_escape: false,
      },
    ]);
    expect(manifest.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.oauth_config.scopes.bot).toContain("commands");
  });

  it("includes writable Messages Tab (app_home) for DMs", () => {
    const cfg = normalizeSlackConfig({
      apps: [
        {
          id: "hdc",
          managed: true,
          display_name: "HDC",
          bot_display_name: "HDC",
          bot_scopes: ["chat:write"],
          interactivity: { enabled: false },
        },
      ],
    });
    const app = cfg.managedApps[0];
    const manifest = configAppToManifest(app);
    expect(manifest.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    const desired = configAppToDesired(app);
    expect(desired.messages_tab_enabled).toBe(true);
    expect(desired.messages_tab_read_only_enabled).toBe(false);
    const liveOff = liveManifestToNormalized({
      display_information: { name: "HDC" },
      features: { bot_user: { display_name: "HDC" } },
      oauth_config: { scopes: { bot: ["chat:write"] } },
      settings: { interactivity: { is_enabled: false } },
    });
    expect(liveOff.messages_tab_enabled).toBe(false);
    expect(appsNeedUpdate(desired, liveOff)).toBe(true);
    const liveOn = liveManifestToNormalized({
      display_information: { name: "HDC" },
      features: {
        bot_user: { display_name: "HDC" },
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
      },
      oauth_config: { scopes: { bot: ["chat:write"] } },
      settings: { interactivity: { is_enabled: false } },
    });
    expect(appsNeedUpdate(desired, liveOn)).toBe(false);
  });

  it("detects events/slash drift", () => {
    const cfg = normalizeSlackConfig({
      apps: [
        {
          id: "hdc",
          managed: true,
          display_name: "HDC Ops",
          bot_display_name: "HDC Ops",
          bot_scopes: ["chat:write", "commands"],
          match: { app_id: "A1" },
          interactivity: { enabled: true, request_url: "https://a.example/api/slack/interactions" },
          event_subscriptions: {
            enabled: true,
            request_url: "https://a.example/api/slack/events",
            bot_events: ["app_mention"],
          },
          slash_commands: [
            { command: "/hdc", description: "Ask", url: "https://a.example/api/slack/commands" },
          ],
        },
      ],
    });
    const app = cfg.managedApps[0];
    const desired = configAppToDesired(app, {
      requestUrl: app.interactivity.request_url,
      eventsRequestUrl: app.event_subscriptions.request_url,
      slashCommands: [
        { command: "/hdc", description: "Ask", url: "https://a.example/api/slack/commands" },
      ],
    });
    const live = liveManifestToNormalized({
      display_information: { name: "HDC Ops" },
      features: { bot_user: { display_name: "HDC Ops" } },
      oauth_config: { scopes: { bot: ["chat:write"] } },
      settings: {
        interactivity: {
          is_enabled: true,
          request_url: "https://a.example/api/slack/interactions",
        },
      },
    });
    expect(appsNeedUpdate(desired, live)).toBe(true);
  });

  it("detects manifest drift", () => {
    const cfg = normalizeSlackConfig({
      apps: [
        {
          id: "hdc",
          managed: true,
          display_name: "HDC Ops",
          bot_display_name: "HDC Ops",
          bot_scopes: ["chat:write", "chat:write.public"],
          match: { app_id: "A1" },
          interactivity: { enabled: true, request_url: "https://a.example/api/slack/interactions" },
        },
      ],
    });
    const app = cfg.managedApps[0];
    const desired = configAppToDesired(app);
    const live = liveManifestToNormalized({
      display_information: { name: "HDC Ops" },
      features: { bot_user: { display_name: "HDC Ops" } },
      oauth_config: { scopes: { bot: ["chat:write"] } },
      settings: {
        interactivity: {
          is_enabled: true,
          request_url: "https://old.example/api/slack/interactions",
        },
      },
    });
    expect(appsNeedUpdate(desired, live)).toBe(true);
    const plan = planAppSync({
      configApp: app,
      live: { app_id: "A1", manifest: { display_information: { name: "HDC Ops" } } },
      requestUrl: desired.request_url,
    });
    expect(plan.action).toBe("update");
    expect(configAppToManifest(app, { requestUrl: desired.request_url }).settings.interactivity.request_url).toBe(
      desired.request_url,
    );
  });

  it("plans create when app_id missing", () => {
    const cfg = normalizeSlackConfig({
      apps: [{ id: "hdc", managed: true, display_name: "HDC Ops" }],
    });
    const plan = planAppSync({ configApp: cfg.managedApps[0], live: null });
    expect(plan.action).toBe("create");
  });
});
