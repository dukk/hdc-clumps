import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";

import {
  CONFIG_LIKE_EXTENSIONS,
  buildPluginConfigSidecar,
  fromGuestRel,
  fromSidecarRel,
  isPluginConfigPathAllowed,
  listLocalPluginConfigSidecars,
  parseFindPluginConfigListing,
  parsePluginConfigSidecar,
  prunePluginConfigSidecars,
  resolvePluginConfigsDirName,
  toGuestRel,
  toSidecarRel,
  writePluginConfigSidecar,
} from "./minecraft-plugin-configs.mjs";

/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeTempDir() {
  const d = mkdtempSync(join(tmpdir(), "hdc-mc-plugin-cfg-"));
  tempDirs.push(d);
  return d;
}

describe("minecraft-plugin-configs path filters", () => {
  it("allows config-like extensions under plugin dirs", () => {
    expect(isPluginConfigPathAllowed("Geyser-Spigot/config.yml")).toBe(true);
    expect(isPluginConfigPathAllowed("BlueMap/core.conf")).toBe(true);
    expect(isPluginConfigPathAllowed("WorldGuard/worlds/world/regions.yml")).toBe(true);
    expect(isPluginConfigPathAllowed("Essentials/config.yml")).toBe(true);
    expect(isPluginConfigPathAllowed("LuckPerms/config.yml")).toBe(true);
    expect(CONFIG_LIKE_EXTENSIONS.has(".yml")).toBe(true);
  });

  it("denies userdata, cache, logs, maps, jars, secrets, and binaries", () => {
    expect(isPluginConfigPathAllowed("Essentials/userdata/alice.yml")).toBe(false);
    expect(isPluginConfigPathAllowed("SomePlugin/user-data/x.yml")).toBe(false);
    expect(isPluginConfigPathAllowed("BlueMap/cache/x.yml")).toBe(false);
    expect(isPluginConfigPathAllowed("BlueMap/logs/latest.log")).toBe(false);
    expect(isPluginConfigPathAllowed("BlueMap/maps/world/settings.conf")).toBe(false);
    expect(isPluginConfigPathAllowed("Foo.jar")).toBe(false);
    expect(isPluginConfigPathAllowed("floodgate/key.pem")).toBe(false);
    expect(isPluginConfigPathAllowed("vault/secret.key")).toBe(false);
    expect(isPluginConfigPathAllowed("LuckPerms/luckperms-h2.mv.db")).toBe(false);
    expect(isPluginConfigPathAllowed("icon.png")).toBe(false);
    expect(isPluginConfigPathAllowed("../escape.yml")).toBe(false);
    expect(isPluginConfigPathAllowed("plugins/Geyser-Spigot/config.yml")).toBe(false);
  });
});

describe("minecraft-plugin-configs path round-trip", () => {
  it("maps guest_rel ↔ sidecar rel", () => {
    expect(toGuestRel("Geyser-Spigot/config.yml")).toBe("plugins/Geyser-Spigot/config.yml");
    expect(fromGuestRel("plugins/Geyser-Spigot/config.yml")).toBe("Geyser-Spigot/config.yml");
    expect(toSidecarRel("Geyser-Spigot/config.yml")).toBe("Geyser-Spigot/config.yml.json");
    expect(fromSidecarRel("Geyser-Spigot/config.yml.json")).toBe("Geyser-Spigot/config.yml");
    expect(fromSidecarRel("BlueMap/core.conf.json")).toBe("BlueMap/core.conf");
  });
});

describe("minecraft-plugin-configs sidecar I/O", () => {
  it("writes and reads wrapper JSON shape", () => {
    const root = makeTempDir();
    const written = writePluginConfigSidecar(root, "Geyser-Spigot/config.yml", "bedrock:\n  port: 19132\n");
    expect(written.guestRel).toBe("plugins/Geyser-Spigot/config.yml");
    expect(written.sidecarRel).toBe("Geyser-Spigot/config.yml.json");
    expect(existsSync(written.abs)).toBe(true);

    const raw = JSON.parse(readFileSync(written.abs, "utf8"));
    expect(raw).toEqual({
      guest_rel: "plugins/Geyser-Spigot/config.yml",
      content: "bedrock:\n  port: 19132\n",
    });
    expect(parsePluginConfigSidecar(raw)).toEqual(raw);
    expect(buildPluginConfigSidecar("x", "plugins/A/b.yml")).toEqual({
      guest_rel: "plugins/A/b.yml",
      content: "x",
    });

    const listed = listLocalPluginConfigSidecars(root);
    expect(listed).toHaveLength(1);
    expect(listed[0].guestRel).toBe("plugins/Geyser-Spigot/config.yml");
    expect(listed[0].content).toContain("19132");
  });

  it("prunes sidecars not in the keep set", () => {
    const root = makeTempDir();
    writePluginConfigSidecar(root, "Keep/config.yml", "keep: true\n");
    writePluginConfigSidecar(root, "Drop/config.yml", "drop: true\n");
    const removed = prunePluginConfigSidecars(root, new Set(["Keep/config.yml"]));
    expect(removed).toContain("Drop/config.yml.json");
    const listed = listLocalPluginConfigSidecars(root);
    expect(listed.map((x) => x.guestRel)).toEqual(["plugins/Keep/config.yml"]);
  });

  it("defaults plugin_configs.dir and rejects path escape", () => {
    expect(resolvePluginConfigsDirName({})).toBe("plugin-configs");
    expect(resolvePluginConfigsDirName({ minecraft: { plugin_configs: { dir: " custom " } } })).toBe(
      "custom",
    );
    expect(
      resolvePluginConfigsDirName({ minecraft: { plugin_configs: { dir: "../escape" } } }),
    ).toBe("plugin-configs");
  });

  it("parses find listing lines", () => {
    const rows = parseFindPluginConfigListing("12\tGeyser-Spigot/config.yml\n999\tBlueMap/core.conf\n");
    expect(rows).toEqual([
      { size: 12, rel: "Geyser-Spigot/config.yml" },
      { size: 999, rel: "BlueMap/core.conf" },
    ]);
  });

  it("ignores invalid sidecar JSON on list", () => {
    const root = makeTempDir();
    const badDir = join(root, "Broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "config.yml.json"), "{not-json", "utf8");
    writePluginConfigSidecar(root, "Ok/config.yml", "ok: 1\n");
    expect(listLocalPluginConfigSidecars(root)).toHaveLength(1);
  });
});
