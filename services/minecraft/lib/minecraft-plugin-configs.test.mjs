import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";

import {
  CONFIG_LIKE_EXTENSIONS,
  WRITE_GUEST_FILE_B64_CHUNK,
  chunkBase64ForRemoteWrite,
  convertLegacyPluginConfigWrappers,
  fromGuestRel,
  isPluginConfigPathAllowedForApply,
  isPluginConfigPathAllowedForImport,
  isPluginLogPath,
  listLocalPluginConfigFiles,
  parseFindPluginConfigListing,
  prunePluginConfigFiles,
  resolvePluginConfigsDirName,
  toGuestRel,
  toSidecarRel,
  writePluginConfigFile,
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
  it("allows config-like extensions under plugin dirs for import and apply", () => {
    expect(isPluginConfigPathAllowedForImport("Geyser-Spigot/config.yml")).toBe(true);
    expect(isPluginConfigPathAllowedForApply("Geyser-Spigot/config.yml")).toBe(true);
    expect(isPluginConfigPathAllowedForImport("BlueMap/core.conf")).toBe(true);
    expect(isPluginConfigPathAllowedForImport("WorldGuard/worlds/world/regions.yml")).toBe(true);
    expect(CONFIG_LIKE_EXTENSIONS.has(".yml")).toBe(true);
  });

  it("denies userdata, cache, maps, jars, secrets, archive-unpack, translations, backups", () => {
    expect(isPluginConfigPathAllowedForImport("Essentials/userdata/alice.yml")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("BlueMap/cache/x.yml")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("BlueMap/maps/world/settings.conf")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("Foo.jar")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("floodgate/key.pem")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("WorldEdit/.archive-unpack/x/strings.json")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("LuckPerms/translations/repository/en.properties")).toBe(
      false,
    );
    expect(isPluginConfigPathAllowedForImport("SignShop/configBackup0808262316.yml")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("../escape.yml")).toBe(false);
  });

  it("imports logs but does not apply them", () => {
    expect(isPluginLogPath("BlueMap/logs/latest.log")).toBe(true);
    expect(isPluginLogPath("DropHeads/dropheads-log.txt")).toBe(true);
    expect(isPluginLogPath("Essentials/config.yml")).toBe(false);

    expect(isPluginConfigPathAllowedForImport("BlueMap/logs/latest.log")).toBe(true);
    expect(isPluginConfigPathAllowedForApply("BlueMap/logs/latest.log")).toBe(false);
    expect(isPluginConfigPathAllowedForImport("DropHeads/dropheads-log.txt")).toBe(true);
    expect(isPluginConfigPathAllowedForApply("DropHeads/dropheads-log.txt")).toBe(false);
  });
});

describe("minecraft-plugin-configs path round-trip", () => {
  it("maps guest_rel ↔ native sidecar rel", () => {
    expect(toGuestRel("Geyser-Spigot/config.yml")).toBe("plugins/Geyser-Spigot/config.yml");
    expect(fromGuestRel("plugins/Geyser-Spigot/config.yml")).toBe("Geyser-Spigot/config.yml");
    expect(toSidecarRel("Geyser-Spigot/config.yml")).toBe("Geyser-Spigot/config.yml");
    expect(toSidecarRel("BlueMap/core.conf")).toBe("BlueMap/core.conf");
  });
});

describe("minecraft-plugin-configs native I/O", () => {
  it("writes and reads native format files", () => {
    const root = makeTempDir();
    const written = writePluginConfigFile(root, "Geyser-Spigot/config.yml", "bedrock:\n  port: 19132\n");
    expect(written.guestRel).toBe("plugins/Geyser-Spigot/config.yml");
    expect(written.sidecarRel).toBe("Geyser-Spigot/config.yml");
    expect(existsSync(written.abs)).toBe(true);
    expect(readFileSync(written.abs, "utf8")).toBe("bedrock:\n  port: 19132\n");

    const listed = listLocalPluginConfigFiles(root);
    expect(listed).toHaveLength(1);
    expect(listed[0].guestRel).toBe("plugins/Geyser-Spigot/config.yml");
    expect(listed[0].content).toContain("19132");
  });

  it("lists logs for import but excludes them from apply listing", () => {
    const root = makeTempDir();
    writePluginConfigFile(root, "Essentials/config.yml", "ok: 1\n");
    writePluginConfigFile(root, "DropHeads/dropheads-log.txt", "line\n");
    expect(listLocalPluginConfigFiles(root, { forApply: false })).toHaveLength(2);
    expect(listLocalPluginConfigFiles(root, { forApply: true }).map((x) => x.sidecarRel)).toEqual([
      "Essentials/config.yml",
    ]);
  });

  it("prunes files not in the keep set", () => {
    const root = makeTempDir();
    writePluginConfigFile(root, "Keep/config.yml", "keep: true\n");
    writePluginConfigFile(root, "Drop/config.yml", "drop: true\n");
    const removed = prunePluginConfigFiles(root, new Set(["Keep/config.yml"]));
    expect(removed).toContain("Drop/config.yml");
    const listed = listLocalPluginConfigFiles(root);
    expect(listed.map((x) => x.guestRel)).toEqual(["plugins/Keep/config.yml"]);
  });

  it("converts legacy JSON wrappers to native files", () => {
    const root = makeTempDir();
    const wrapDir = join(root, "Essentials");
    mkdirSync(wrapDir, { recursive: true });
    writeFileSync(
      join(wrapDir, "worth.yml.json"),
      JSON.stringify({
        guest_rel: "plugins/Essentials/worth.yml",
        content: "worth:\n  log: 2.0\n",
      }),
      "utf8",
    );
    const n = convertLegacyPluginConfigWrappers(root);
    expect(n).toBe(1);
    expect(existsSync(join(wrapDir, "worth.yml.json"))).toBe(false);
    expect(readFileSync(join(wrapDir, "worth.yml"), "utf8")).toContain("log: 2.0");
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
});

describe("chunkBase64ForRemoteWrite", () => {
  it("splits large base64 into fixed-size chunks under SSH argv limits", () => {
    const b64 = "A".repeat(WRITE_GUEST_FILE_B64_CHUNK * 2 + 10);
    const chunks = chunkBase64ForRemoteWrite(b64);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(WRITE_GUEST_FILE_B64_CHUNK);
    expect(chunks[1]).toHaveLength(WRITE_GUEST_FILE_B64_CHUNK);
    expect(chunks[2]).toHaveLength(10);
    expect(chunks.join("")).toBe(b64);
  });

  it("returns a single chunk for small payloads", () => {
    expect(chunkBase64ForRemoteWrite("abc")).toEqual(["abc"]);
    expect(chunkBase64ForRemoteWrite("")).toEqual([]);
  });
});
