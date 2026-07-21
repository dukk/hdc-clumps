import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { normalizeDiscordConfig } from "./discord-config.mjs";
import {
  applyAppIcon,
  collectIconState,
  fileToDataUri,
  iconNeedsUpdate,
  resolveAppIconPath,
  sha256File,
} from "./discord-icon.mjs";

describe("discord-icon", () => {
  it("resolves icon path under hdc repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-discord-icon-"));
    const rel = "assets/icon.png";
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, rel), "png-bytes");
    const cfg = normalizeDiscordConfig({
      applications: [{ id: "hdc-ops", bot_token_vault_key: "X", icon: { repo_path: rel } }],
    });
    expect(resolveAppIconPath(cfg.applications[0], dir)).toBe(join(dir, rel));
  });

  it("builds data URI from png file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-discord-icon-"));
    const filePath = join(dir, "icon.png");
    writeFileSync(filePath, "png-bytes");
    expect(fileToDataUri(filePath)).toBe(
      `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
    );
  });

  it("detects icon drift from applied_sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-discord-icon-"));
    const filePath = join(dir, "icon.png");
    writeFileSync(filePath, "v1");
    const sha = sha256File(filePath);
    const cfg = normalizeDiscordConfig({
      applications: [
        {
          id: "hdc-ops",
          bot_token_vault_key: "X",
          icon: { repo_path: "x", applied_sha256: sha },
        },
      ],
    });
    expect(iconNeedsUpdate(cfg.applications[0], filePath)).toBe(false);
    writeFileSync(filePath, "v2");
    expect(iconNeedsUpdate(cfg.applications[0], filePath)).toBe(true);
  });

  it("collectIconState reports drift when applied hash missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-discord-icon-"));
    const rel = "assets/icon.png";
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, rel), "png");
    const cfg = normalizeDiscordConfig({
      applications: [{ id: "hdc-ops", bot_token_vault_key: "X", icon: { repo_path: rel } }],
    });
    const state = collectIconState(cfg.applications[0], dir);
    expect(state.configured).toBe(true);
    expect(state.drift).toBe(true);
    expect(state.local_sha256).toHaveLength(64);
  });

  it("PATCHes icon as data URI on upload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-discord-icon-"));
    const filePath = join(dir, "icon.png");
    writeFileSync(filePath, "png-bytes");
    const cfg = normalizeDiscordConfig({
      applications: [{ id: "hdc-ops", bot_token_vault_key: "X", icon: { repo_path: "x" } }],
    });
    const patchCurrentApplication = vi.fn(async (patch) => {
      expect(patch.icon).toBe(fileToDataUri(filePath));
      return { id: "123" };
    });
    const api = { patchCurrentApplication };
    const result = await applyAppIcon(api, cfg.applications[0], filePath);
    expect(result.action).toBe("upload");
    expect(patchCurrentApplication).toHaveBeenCalledOnce();
  });

  it("applyAppIcon skips upload when hash matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-discord-icon-"));
    const filePath = join(dir, "icon.png");
    writeFileSync(filePath, "same");
    const sha = sha256File(filePath);
    const cfg = normalizeDiscordConfig({
      applications: [
        {
          id: "hdc-ops",
          bot_token_vault_key: "X",
          icon: { repo_path: "assets/icon.png", applied_sha256: sha },
        },
      ],
    });
    const api = {
      patchCurrentApplication: vi.fn(),
    };
    const result = await applyAppIcon(api, cfg.applications[0], filePath);
    expect(result.action).toBe("unchanged");
    expect(api.patchCurrentApplication).not.toHaveBeenCalled();
  });
});
