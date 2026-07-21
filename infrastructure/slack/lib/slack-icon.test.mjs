import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSlackManifestClient } from "./slack-api.mjs";
import {
  applyAppIcon,
  collectIconState,
  iconNeedsUpdate,
  resolveAppIconPath,
  sha256File,
} from "./slack-icon.mjs";
import { normalizeSlackConfig } from "./slack-config.mjs";

describe("slack-icon", () => {
  it("resolves icon path under hdc repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-slack-icon-"));
    const rel = "assets/icon.png";
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, rel), "png-bytes");
    const cfg = normalizeSlackConfig({
      apps: [{ id: "hdc", icon: { repo_path: rel } }],
    });
    expect(resolveAppIconPath(cfg.apps[0], dir)).toBe(join(dir, rel));
  });

  it("detects icon drift from applied_sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-slack-icon-"));
    const filePath = join(dir, "icon.png");
    writeFileSync(filePath, "v1");
    const sha = sha256File(filePath);
    const cfg = normalizeSlackConfig({
      apps: [{ id: "hdc", icon: { repo_path: "x", applied_sha256: sha } }],
    });
    expect(iconNeedsUpdate(cfg.apps[0], filePath)).toBe(false);
    writeFileSync(filePath, "v2");
    expect(iconNeedsUpdate(cfg.apps[0], filePath)).toBe(true);
  });

  it("collectIconState reports drift when applied hash missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-slack-icon-"));
    const rel = "assets/icon.png";
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, rel), "png");
    const cfg = normalizeSlackConfig({
      apps: [{ id: "hdc", icon: { repo_path: rel } }],
    });
    const state = collectIconState(cfg.apps[0], dir);
    expect(state.configured).toBe(true);
    expect(state.drift).toBe(true);
    expect(state.local_sha256).toHaveLength(64);
  });

  it("posts multipart upload to apps.icon.set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-slack-icon-"));
    const filePath = join(dir, "icon.png");
    writeFileSync(filePath, "png-bytes");
    const fetchFn = vi.fn(async (url, init) => {
      expect(String(url)).toContain("apps.icon.set");
      expect(init?.method).toBe("POST");
      expect(init?.headers?.Authorization).toBe("Bearer test-token");
      expect(init?.body).toBeInstanceOf(FormData);
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    });
    const api = createSlackManifestClient({
      token: "test-token",
      fetchFn,
    });
    await api.setAppIcon("A123", filePath);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("applyAppIcon skips upload when hash matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hdc-slack-icon-"));
    const filePath = join(dir, "icon.png");
    writeFileSync(filePath, "same");
    const sha = sha256File(filePath);
    const cfg = normalizeSlackConfig({
      apps: [{ id: "hdc", icon: { repo_path: "assets/icon.png", applied_sha256: sha } }],
    });
    const api = {
      setAppIcon: vi.fn(),
    };
    const result = await applyAppIcon(api, cfg.apps[0], "A123", filePath);
    expect(result.action).toBe("unchanged");
    expect(api.setAppIcon).not.toHaveBeenCalled();
  });
});
