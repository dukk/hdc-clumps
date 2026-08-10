# Minecraft Paper server (`minecraft`)

Proxmox **QEMU** Ubuntu guest running [Paper](https://papermc.io/) (Fill v3 downloads) with **Geyser-Spigot** + **Floodgate** so Java Edition and Windows/Bedrock clients share one world. Optional plugins: **BlueMap**, **EssentialsX** (+ Chat/Spawn), **WorldEdit**, **WorldGuard**, **Vault**, **Thizzy'z Tree Feller**, plus legacy survival flags **Chunky**, **DeadChest**, **DecentHolograms**, **DropHeads**, **LuckPerms**, **ProtocolLib**, **requests** (HTTP API — no extra UniFi forward), **SignShop**, **SilkSpawners**, **VanishNoPacket** (Hangar Refined fork), **WorldEditSUI**. systemd `minecraft.service` uses `Restart=on-failure` and an `ExecStop` that warns players (localhost RCON) before stop.

Game ports are **not** HTTP — do not proxy them through nginx-waf. Public play uses UniFi port forwards on the WAF WAN IPs plus a **gray-cloud** `minecraft.dukk.org` CNAME (still targeting `waf.dukk.org`). **BlueMap** is HTTP on guest `:8100` and is reverse-proxied at `https://minecraft.dukk.org` (same gray-cloud name — do not orange-cloud).

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `clumps/services/minecraft/config.json` in **hdc-private**.
- **Inventory:** `operations/inventory/systems/virtual/vm-minecraft-a.json`, `operations/inventory/services/minecraft.json`.
- `minecraft.eula` must be `true` (Mojang EULA).

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Clone QEMU Ubuntu template, cloud-init static IP, install OpenJDK 25 + Paper + plugins, enable systemd |
| `maintain` | Import live whitelist/ops first, then re-apply unit/`server.properties`/`whitelist.json`/`ops.json`/plugins; push `plugin-configs/` sidecars to the guest; optional Paper refresh; guest Linux baseline; ensure 6-hourly world dump timer |
| `query` | Config summary; `--live` for `systemctl` + TCP 25565 (+ BlueMap `:8100` when enabled); `--import --yes` pulls live whitelist/ops **and** plugin config trees into hdc-private |
| `health` | DNS + direct TCP 25565; BlueMap TCP + public HTTPS when enabled |
| `teardown` | Destroy QEMU guest |

```bash
hdc run service minecraft deploy -- --instance a
hdc run service minecraft query -- --import --yes
hdc run service minecraft maintain -- --skip-upgrade
hdc run service minecraft query -- --live
hdc run service minecraft teardown -- --instance a --dry-run
```

### Deploy flags

`--instance`, `--system-id`, `--destroy-existing`, `--skip-provision`, `--skip-install`, `--skip-existing`, `--redeploy-existing`

### Maintain flags

`--skip-upgrade` (keep existing **Paper** jar; still download missing plugin jars), `--skip-clamav`, `--skip-admin-user`, `--skip-resources`, `--skip-disk-resize`, `--skip-lists-import` (skip automatic live whitelist/ops import), `--skip-plugin-configs` (skip pushing `plugin-configs/` sidecars), `--skip-app-dump` (skip world dump timer), `--no-reboot`, `--reboot`, `--dry-run`, `--no-report`

### Query flags

`--live`, `--import --yes` (merge live whitelist/ops into hdc-private; live wins on UUID conflict, config-only entries kept; also snapshot guest `plugins/**` config-like files into native `plugin-configs/` files; logs imported but not applied later), `--instance`, `--system-id`

## Ports

| Protocol | Port | Clients |
|----------|------|---------|
| TCP | `25565` | Java Edition |
| UDP | `19132` | Bedrock / Windows Minecraft (Geyser) |
| TCP | `8100` | BlueMap web (LAN; nginx-waf publishes HTTPS) |

LAN: `minecraft-a.hdc.dukk.org:25565`. Public play: `minecraft.dukk.org:25565` after UniFi PF + DNS-only Cloudflare. Map: `https://minecraft.dukk.org`.

Heap defaults: `-Xms2G -Xmx5G` (`minecraft.java_heap_min` / `java_heap`). systemd `ExecStart` also includes [Aikar G1GC flags](https://docs.papermc.io/paper/aikars-flags) by default; override with `minecraft.java_jvm_args` (non-empty string replaces the default flag set). Grow the QEMU root disk on maintain when `defaults.proxmox.qemu.rootfs_gb` exceeds live size.

Gameplay identity: `minecraft.motd`, `max_players`, `online_mode`, optional `whitelist` (+ `enforce` + `players[]` via `{ "$hdc.include": "whitelist.json" }`), `ops[]`, and extra `server.properties` keys (`difficulty`, `view-distance`, `simulation-distance`, `enable-query`, …). Keep `prevent-proxy-connections` **false** on standalone Paper behind UniFi hairpin/LAN (Java kick `Failed to verify username!` when Mojang sees WAN IP and Paper sees LAN). Leave `online_mode` true. Optional Paper 26 world-defaults: `paper.per_player_mob_spawns`, `paper.keep_spawn_loaded_range`, `paper.anti_xray` (legacy `paper.yml` does not map 1:1). Whitelist `players[]` may set `"edition": "bedrock"` (Xbox gamertag `name`, optional `xuid` / Floodgate `uuid`); `/whitelist add` is Java-only. Deploy/maintain resolve missing Floodgate UUIDs, write Paper `whitelist.json` with the Floodgate username prefix (default `.`), and set Paper `perform-username-validation: false` so `.Gamertag` can join. Plugin jars download from GitHub / Modrinth / Hangar / LuckPerms metadata / CurseForge (cfwidget); Chunky uses the **bukkit** loader, not Fabric.

**Plugin configs:** `query --import --yes` copies config-like files under guest `/opt/minecraft/plugins/` into hdc-private `plugin-configs/<rel>` as **native-format** files (same `.yml`/`.conf`/… content, not JSON wrappers). Log files are imported for archival but **never** applied on maintain. Skips userdata/cache/maps/`.archive-unpack`/translations, jars, DB files, backups, and secrets (e.g. `*.pem`). Maintain builds a change plan while the server is up, stops only when files differ, writes only those files, then starts; use `--skip-plugin-configs` to leave guest plugin trees untouched. Optional `minecraft.plugin_configs.dir` (default `plugin-configs`).

**Stop warning:** `minecraft.stop_warning` (default enabled, 10s) installs localhost RCON + `hdc-minecraft-graceful-stop` as systemd `ExecStop`, so `systemctl stop|restart minecraft` announces in chat before shutting down. RCON password is guest-local (`/opt/minecraft/.rcon.password`).

**World backups:** `minecraft.backup` (default every 6h, keep newest archive per day for 7 days) installs `hdc-dump-minecraft.timer` writing `/var/backups/hdc/minecraft/minecraft-YYYYMMDD-HHMMSS.tar.gz` (worlds + lists/config/plugins; excludes jars/caches). Skip with `--skip-app-dump`.

No vault secrets for v1.

## Related

- Schema: [`minecraft.config.schema.json`](../../../hdc/apps/hdc-cli/schema/minecraft.config.schema.json)
