import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  homepageConfigFilePaths,
  loadHomepageConfigFiles,
  validateHomepageConfigFiles,
} from "./homepage-config-load.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("homepage-config-load", () => {
  it("validateHomepageConfigFiles requires all three paths", () => {
    expect(() => validateHomepageConfigFiles({})).toThrow(/config_files is required/);
    expect(() =>
      validateHomepageConfigFiles({
        config_files: { services: "homepage/services.yaml" },
      }),
    ).toThrow(/settings is required/);
  });

  it("homepageConfigFilePaths returns trimmed paths", () => {
    const paths = homepageConfigFilePaths({
      config_files: {
        services: " homepage/services.yaml ",
        settings: "homepage/settings.yaml",
        bookmarks: "homepage/bookmarks.yaml",
      },
    });
    expect(paths.services).toBe("homepage/services.yaml");
  });

  it("loadHomepageConfigFiles reads example yaml from package", () => {
    const exampleServices = join(packageRoot, "homepage", "services.example.yaml");
    if (!existsSync(exampleServices)) {
      return;
    }
    const loaded = loadHomepageConfigFiles(
      {
        config_files: {
          services: "homepage/services.example.yaml",
          settings: "homepage/settings.example.yaml",
          bookmarks: "homepage/bookmarks.example.yaml",
        },
      },
      packageRoot,
    );
    expect(loaded.servicesYaml).toMatch(/-/);
    expect(loaded.settingsYaml).toContain("title:");
    expect(loaded.bookmarksYaml).toBe("[]\n");
  });

  it("loadHomepageConfigFiles reads optional widgets yaml", () => {
    const exampleWidgets = join(packageRoot, "homepage", "widgets.example.yaml");
    if (!existsSync(exampleWidgets)) {
      return;
    }
    const loaded = loadHomepageConfigFiles(
      {
        config_files: {
          services: "homepage/services.example.yaml",
          settings: "homepage/settings.example.yaml",
          bookmarks: "homepage/bookmarks.example.yaml",
          widgets: "homepage/widgets.example.yaml",
        },
      },
      packageRoot,
    );
    expect(loaded.widgetsYaml).toContain("datetime:");
    expect(loaded.config_paths.widgets).toBe("homepage/widgets.example.yaml");
  });
});
