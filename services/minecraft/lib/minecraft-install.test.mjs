import { describe, expect, it } from "vitest";

import { mergeMinecraftSettings } from "./deployments.mjs";
import {
  renderServerProperties,
  renderWhitelistJson,
  renderOpsJson,
  renderSystemdUnit,
  resolveLinuxUser,
  buildInstallShellScript,
  flattenPaperVersions,
  pickPaperBuild,
  pickGithubReleaseAsset,
  pickModrinthPrimaryUrl,
  pickHangarDownloadUrl,
  pickLuckPermsBukkitUrl,
  pickCfwidgetForgecdnUrl,
  isRequestsJarCurrentEnough,
} from "./minecraft-install.mjs";

const mc = {
  paperVersion: "1.21.8",
  eula: true,
  javaHeapMin: "2G",
  javaHeap: "5G",
  javaJvmArgs: "",
  installDir: "/opt/minecraft",
  javaPort: 25565,
  bedrockPort: 19132,
  motd: "HDC Minecraft",
  maxPlayers: 20,
  onlineMode: true,
  geyser: true,
  floodgate: true,
  bluemap: true,
  bluemapWebPort: 8100,
  essentialsx: true,
  essentialsxChat: true,
  essentialsxSpawn: true,
  worldedit: true,
  worldguard: true,
  vault: true,
  treeFeller: true,
  chunky: false,
  deadChest: false,
  decentHolograms: false,
  dropHeads: false,
  luckperms: false,
  protocollib: false,
  requests: false,
  signshop: false,
  silkSpawners: false,
  vanishNoPacket: false,
  worldeditSui: false,
  spark: false,
  serverProperties: {},
  whitelist: null,
  ops: null,
  paperExtras: {},
};

const pluginJars = [
  { dest: "Geyser-Spigot.jar", url: "https://example.invalid/geyser.jar" },
  { dest: "floodgate-spigot.jar", url: "https://example.invalid/floodgate.jar" },
  { dest: "Vault.jar", url: "https://example.invalid/vault.jar" },
  { dest: "EssentialsX.jar", url: "https://example.invalid/essentialsx.jar" },
  { dest: "EssentialsXChat.jar", url: "https://example.invalid/essentialsx-chat.jar" },
  { dest: "EssentialsXSpawn.jar", url: "https://example.invalid/essentialsx-spawn.jar" },
  { dest: "WorldEdit.jar", url: "https://example.invalid/worldedit.jar" },
  { dest: "WorldGuard.jar", url: "https://example.invalid/worldguard.jar" },
  { dest: "BlueMap.jar", url: "https://example.invalid/bluemap.jar" },
  { dest: "TreeFeller.jar", url: "https://example.invalid/treefeller.jar" },
];

describe("minecraft-install", () => {
  it("rejects invalid linux_user", () => {
    expect(() => resolveLinuxUser({ linux_user: "Minecraft" })).toThrow(/linux_user/);
    expect(resolveLinuxUser({})).toBe("minecraft");
  });

  it("renders server.properties with java port, online-mode, and forced RCON", () => {
    const props = renderServerProperties(mc);
    expect(props).toContain("server-port=25565");
    expect(props).toContain("online-mode=true");
    expect(props).toContain("motd=HDC Minecraft");
    expect(props).toContain("enable-rcon=true");
    expect(props).toContain("rcon.port=25575");
    expect(props).not.toContain("rcon.password=");
  });

  it("merges whitelist, ops, and server.properties from config", () => {
    const merged = mergeMinecraftSettings(
      {
        minecraft: {
          motd: "minecraft.example.invalid",
          whitelist: {
            enabled: true,
            enforce: true,
            players: [{ uuid: "00000000-0000-4000-8000-000000000001", name: "alice" }],
          },
          ops: [
            {
              uuid: "00000000-0000-4000-8000-000000000001",
              name: "alice",
              level: 4,
              bypassesPlayerLimit: false,
            },
          ],
          server_properties: {
            "enable-command-block": true,
            difficulty: "easy",
            "enable-query": false,
            "view-distance": 18,
            "simulation-distance": 16,
            "prevent-proxy-connections": false,
          },
          paper: { per_player_mob_spawns: false, keep_spawn_loaded_range: 10, anti_xray: false },
        },
      },
      {},
    );
    expect(merged.motd).toBe("minecraft.example.invalid");
    expect(merged.whitelist).toEqual({
      enabled: true,
      enforce: true,
      players: [{ uuid: "00000000-0000-4000-8000-000000000001", name: "alice", edition: "java" }],
    });
    expect(merged.ops).toEqual([
      {
        uuid: "00000000-0000-4000-8000-000000000001",
        name: "alice",
        level: 4,
        bypassesPlayerLimit: false,
      },
    ]);
    expect(merged.serverProperties["enable-command-block"]).toBe(true);
    expect(merged.paperExtras).toEqual({
      perPlayerMobSpawns: false,
      keepSpawnLoadedRange: 10,
      antiXray: false,
    });
    const props = renderServerProperties(merged);
    expect(props).toContain("white-list=true");
    expect(props).toContain("enforce-whitelist=true");
    expect(props).toContain("enable-command-block=true");
    expect(props).toContain("difficulty=easy");
    expect(props).toContain("enable-query=false");
    expect(props).toContain("simulation-distance=16");
    expect(props).toContain("view-distance=18");
    expect(props).toContain("prevent-proxy-connections=false");
    expect(renderWhitelistJson(merged.whitelist.players)).toContain("alice");
    expect(renderOpsJson(merged.ops)).toContain('"level": 4');
    const bedrockMerged = mergeMinecraftSettings(
      {
        minecraft: {
          whitelist: {
            enabled: true,
            enforce: true,
            players: [
              {
                edition: "bedrock",
                name: "MJGamer145572",
                xuid: "2535409715482502",
                uuid: "00000000-0000-0000-0009-01f113738f86",
              },
            ],
          },
        },
      },
      {},
    );
    expect(bedrockMerged.whitelist.players).toEqual([
      {
        uuid: "00000000-0000-0000-0009-01f113738f86",
        name: "MJGamer145572",
        edition: "bedrock",
        xuid: "2535409715482502",
      },
    ]);
    const pendingBedrock = mergeMinecraftSettings(
      {
        minecraft: {
          whitelist: {
            enabled: true,
            players: [{ edition: "bedrock", name: "Steve" }],
          },
        },
      },
      {},
    );
    expect(pendingBedrock.whitelist.players).toEqual([{ uuid: "", name: "Steve", edition: "bedrock" }]);
    expect(renderWhitelistJson(bedrockMerged.whitelist.players)).toContain(".MJGamer145572");
    expect(renderWhitelistJson(bedrockMerged.whitelist.players)).not.toContain('"edition"');
  });

  it("renders systemd unit with Restart=on-failure and ExecStop warn", () => {
    const unit = renderSystemdUnit("minecraft", "/opt/minecraft", "2G", "5G");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10");
    expect(unit).toContain("User=minecraft");
    expect(unit).toContain("-Xms2G -Xmx5G");
    expect(unit).toContain("-XX:+UseG1GC");
    expect(unit).toContain("-Daikars.new.flags=true");
    expect(unit).toContain("-jar paper.jar nogui");
    expect(unit).toContain("ExecStop=/usr/local/sbin/hdc-minecraft-graceful-stop");
    expect(unit).toContain("TimeoutStopSec=120");
  });

  it("omits ExecStop when stop_warning disabled", () => {
    const unit = renderSystemdUnit("minecraft", "/opt/minecraft", "2G", "5G", "", {
      enabled: false,
      seconds: 10,
    });
    expect(unit).not.toContain("ExecStop=");
    expect(unit).toContain("TimeoutStopSec=90");
  });

  it("renders systemd unit with custom java_jvm_args", () => {
    const unit = renderSystemdUnit("minecraft", "/opt/minecraft", "12G", "12G", "-XX:+UseG1GC -XX:MaxGCPauseMillis=200");
    expect(unit).toContain("-Xms12G -Xmx12G -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -jar paper.jar nogui");
    expect(unit).not.toContain("aikars.new.flags");
  });

  it("flattens Fill v3 version groups newest-first", () => {
    expect(
      flattenPaperVersions({
        "26.2": ["26.2", "26.2-rc-2"],
        "1.21": ["1.21.11", "1.21.8"],
      }),
    ).toEqual(["26.2", "26.2-rc-2", "1.21.11", "1.21.8"]);
  });

  it("picks STABLE Paper build over experimental", () => {
    const picked = pickPaperBuild([
      { id: 9, channel: "BETA", downloads: {} },
      { id: 111, channel: "STABLE", downloads: { "server:default": { name: "paper.jar" } } },
    ]);
    expect(picked?.id).toBe(111);
  });

  it("picks GitHub release asset by name regex", () => {
    expect(
      pickGithubReleaseAsset(
        [
          { name: "bluemap-5.22-spigot.jar", browser_download_url: "https://example.invalid/spigot.jar" },
          { name: "bluemap-5.22-paper.jar", browser_download_url: "https://example.invalid/paper.jar" },
        ],
        /bluemap-.*-paper\.jar$/i,
      ),
    ).toBe("https://example.invalid/paper.jar");
    expect(
      pickGithubReleaseAsset(
        [
          { name: "source.zip", browser_download_url: "https://example.invalid/src.zip" },
          { name: "TreeFeller-1.30.2.jar", browser_download_url: "https://example.invalid/tf.jar" },
        ],
        /^TreeFeller-.*\.jar$/i,
      ),
    ).toBe("https://example.invalid/tf.jar");
    expect(pickGithubReleaseAsset([], /Vault/)).toBeNull();
  });

  it("picks Modrinth paper loader file", () => {
    expect(
      pickModrinthPrimaryUrl([
        {
          loaders: ["fabric"],
          files: [{ url: "https://example.invalid/fabric.jar", primary: true }],
        },
        {
          loaders: ["paper", "bukkit"],
          files: [
            { url: "https://example.invalid/we-src.jar", primary: false },
            { url: "https://example.invalid/worldedit.jar", primary: true },
          ],
        },
      ]),
    ).toBe("https://example.invalid/worldedit.jar");
  });

  it("does not fall back to Fabric when preferring bukkit loaders", () => {
    expect(
      pickModrinthPrimaryUrl(
        [
          {
            loaders: ["fabric"],
            files: [{ url: "https://example.invalid/Chunky-Fabric-1.5.3.jar", primary: true }],
          },
          {
            loaders: ["forge"],
            files: [{ url: "https://example.invalid/Chunky-Forge-1.5.4.jar", primary: true }],
          },
        ],
        ["bukkit", "paper", "spigot"],
      ),
    ).toBeNull();
    expect(
      pickModrinthPrimaryUrl(
        [
          {
            loaders: ["fabric"],
            files: [{ url: "https://example.invalid/Chunky-Fabric-1.5.3.jar", primary: true }],
          },
          {
            loaders: ["bukkit", "paper", "spigot"],
            files: [{ url: "https://example.invalid/Chunky-Bukkit-1.5.3.jar", primary: true }],
          },
        ],
        ["bukkit", "paper", "spigot"],
      ),
    ).toBe("https://example.invalid/Chunky-Bukkit-1.5.3.jar");
  });

  it("parses LuckPerms metadata bukkit download", () => {
    expect(
      pickLuckPermsBukkitUrl({
        downloads: {
          bukkit: "https://download.luckperms.net/1568/bukkit/loader/LuckPerms-Bukkit-5.5.25.jar",
          fabric: "https://example.invalid/lp-fabric.jar",
        },
      }),
    ).toBe("https://download.luckperms.net/1568/bukkit/loader/LuckPerms-Bukkit-5.5.25.jar");
    expect(pickLuckPermsBukkitUrl({ downloads: {} })).toBeNull();
  });

  it("prefers Hangar Release PAPER download over Snapshot", () => {
    expect(
      pickHangarDownloadUrl({
        result: [
          {
            channel: { name: "Snapshot" },
            downloads: {
              PAPER: {
                downloadUrl:
                  "https://hangarcdn.papermc.io/plugins/Escape_Systems/VanishNoPacket-Refined/versions/snap/PAPER/VanishNoPacket-snap.jar",
              },
            },
          },
          {
            channel: { name: "Release" },
            downloads: {
              PAPER: {
                downloadUrl:
                  "https://hangarcdn.papermc.io/plugins/kennytv/WorldEditSUI/versions/1.8.0/PAPER/WorldEditSUI-1.8.0.jar",
              },
            },
          },
        ],
      }),
    ).toBe(
      "https://hangarcdn.papermc.io/plugins/kennytv/WorldEditSUI/versions/1.8.0/PAPER/WorldEditSUI-1.8.0.jar",
    );
  });

  it("builds CurseForge mediafilez URL from cfwidget download id", () => {
    expect(
      pickCfwidgetForgecdnUrl({
        download: { id: 8024433, name: "DropHeads_v3.10.10.jar" },
      }),
    ).toBe("https://mediafilez.forgecdn.net/files/8024/433/DropHeads_v3.10.10.jar");
    expect(
      pickCfwidgetForgecdnUrl({
        download: { id: 7368111, name: "SignShop-5.2.0.jar" },
      }),
    ).toBe("https://mediafilez.forgecdn.net/files/7368/111/SignShop-5.2.0.jar");
  });

  it("skips ancient Requests 1.19 jars and accepts 1.21.x", () => {
    expect(isRequestsJarCurrentEnough("Requests-1.19.4.jar", "1.19.4")).toBe(false);
    expect(isRequestsJarCurrentEnough("requests-0.3.0-1.21.x.jar", "0.3.0")).toBe(true);
  });

  it("merges legacy plugin flags off by default", () => {
    const off = mergeMinecraftSettings({ minecraft: {} }, {});
    expect(off.chunky).toBe(false);
    expect(off.luckperms).toBe(false);
    expect(off.vanishNoPacket).toBe(false);
    expect(off.spark).toBe(false);
    const on = mergeMinecraftSettings(
      {
        minecraft: {
          chunky: true,
          dead_chest: true,
          decent_holograms: true,
          drop_heads: true,
          luckperms: true,
          protocollib: true,
          requests: true,
          signshop: true,
          silk_spawners: true,
          vanish_no_packet: true,
          worldedit_sui: true,
          spark: true,
          clamav_profile: "lean",
        },
      },
      {},
    );
    expect(on.chunky).toBe(true);
    expect(on.deadChest).toBe(true);
    expect(on.decentHolograms).toBe(true);
    expect(on.dropHeads).toBe(true);
    expect(on.luckperms).toBe(true);
    expect(on.protocollib).toBe(true);
    expect(on.requests).toBe(true);
    expect(on.signshop).toBe(true);
    expect(on.silkSpawners).toBe(true);
    expect(on.vanishNoPacket).toBe(true);
    expect(on.worldeditSui).toBe(true);
    expect(on.spark).toBe(true);
    expect(on.clamavProfile).toBe("lean");
  });

  it("does not download a spark plugin jar (Paper 1.21+ bundles spark)", () => {
    const script = buildInstallShellScript({
      install: { linux_user: "minecraft" },
      minecraft: { ...mc, spark: true },
      paper: {
        version: "1.21.8",
        build: 10,
        name: "paper-1.21.8-10.jar",
        url: "https://example.invalid/paper.jar",
      },
      pluginJars,
    });
    expect(script).not.toContain("spark.jar");
  });

  it("install script downloads Paper, plugins, and patches BlueMap", () => {
    const full = buildInstallShellScript({
      install: { linux_user: "minecraft" },
      minecraft: mc,
      paper: { version: "1.21.8", build: 10, name: "paper-1.21.8-10.jar", url: "https://example.invalid/paper.jar" },
      pluginJars,
    });
    expect(full).toContain("openjdk-25-jre-headless");
    expect(full).toContain("https://example.invalid/paper.jar");
    expect(full).toContain("Geyser-Spigot.jar");
    expect(full).toContain("section in ('java', 'remote')");
    expect(full).toContain("out.append('  port: 19132')");
    expect(full).not.toContain("{mc.bedrockPort}");
    expect(full).toContain("floodgate-spigot.jar");
    expect(full).toContain("NEED_PAPER_GLOBAL=1");
    expect(full).toContain("perform-username-validation: false");
    expect(full).toContain("BlueMap.jar");
    expect(full).toContain("EssentialsX.jar");
    expect(full).toContain("WorldGuard.jar");
    expect(full).toContain("Vault.jar");
    expect(full).toContain("TreeFeller.jar");
    expect(full).toContain("accept-download");
    expect(full).toContain("NEED_BLUEMAP=1");
    expect(full).toContain("Restart=on-failure");
    expect(full).toContain("ExecStop=/usr/local/sbin/hdc-minecraft-graceful-stop");
    expect(full).toContain("hdc-minecraft-rcon");
    expect(full).toContain("hdc-minecraft-graceful-stop");
    expect(full).toContain(".rcon.password");
    expect(full).toContain("enable-rcon=true");

    const withLists = buildInstallShellScript({
      install: { linux_user: "minecraft" },
      minecraft: {
        ...mc,
        whitelist: {
          enabled: true,
          enforce: true,
          players: [{ uuid: "00000000-0000-4000-8000-000000000001", name: "alice" }],
        },
        ops: [
          {
            uuid: "00000000-0000-4000-8000-000000000001",
            name: "alice",
            level: 4,
            bypassesPlayerLimit: false,
          },
        ],
        serverProperties: { difficulty: "easy", "enable-command-block": true },
        paperExtras: { perPlayerMobSpawns: false, keepSpawnLoadedRange: 10, antiXray: false },
      },
      paper: { version: "1.21.8", build: 10, name: "paper-1.21.8-10.jar", url: "https://example.invalid/paper.jar" },
      pluginJars,
    });
    expect(withLists).toContain("whitelist.json");
    expect(withLists).toContain("alice");
    expect(withLists).toContain("ops.json");
    expect(withLists).toContain("difficulty=easy");
    expect(withLists).toContain("NEED_PAPER_WORLD=1");
    expect(withLists).toContain("per-player-mob-spawns: false");
    expect(withLists).toContain("keep-spawn-loaded-range: 10");

    const skip = buildInstallShellScript({
      install: { linux_user: "minecraft" },
      minecraft: mc,
      paper: { version: "1.21.8", build: 10, name: "paper.jar", url: "" },
      pluginJars,
      flags: { skipJarDownload: true },
    });
    expect(skip).toContain('test -f "$INSTALL_DIR/paper.jar"');
    expect(skip).toContain("Geyser-Spigot.jar");
    expect(skip).toContain("if [ ! -f \"$INSTALL_DIR/plugins/BlueMap.jar\" ]");
    expect(skip).not.toContain("https://example.invalid/paper.jar");
  });
});
