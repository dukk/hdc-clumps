# Minecraft Paper server (`minecraft`)

Proxmox **QEMU** Ubuntu guest running [Paper](https://papermc.io/) (Fill v3 downloads) with **Geyser-Spigot** + **Floodgate** so Java Edition and Windows/Bedrock clients share one world. Optional plugins: **BlueMap**, **EssentialsX** (+ Chat/Spawn), **WorldEdit**, **WorldGuard**, **Vault**, **Thizzy'z Tree Feller**, plus legacy survival flags **Chunky**, **DeadChest**, **DecentHolograms**, **DropHeads**, **LuckPerms**, **ProtocolLib**, **requests** (HTTP API — no extra UniFi forward), **SignShop**, **SilkSpawners**, **VanishNoPacket** (Hangar Refined fork), **WorldEditSUI**. systemd `minecraft.service` uses `Restart=on-failure`.

Game ports are **not** HTTP — do not proxy them through nginx-waf. Public play uses UniFi port forwards on the WAF WAN IPs plus a **gray-cloud** `minecraft.dukk.org` CNAME (still targeting `waf.dukk.org`). **BlueMap** is HTTP on guest `:8100` and is reverse-proxied at `https://minecraft.dukk.org` (same gray-cloud name — do not orange-cloud).

## Prerequisites

- **Config:** copy [`config.example.json`](config.example.json) to `clumps/services/minecraft/config.json` in **hdc-private**.
- **Inventory:** `operations/inventory/systems/virtual/vm-minecraft-a.json`, `operations/inventory/services/minecraft.json`.
- `minecraft.eula` must be `true` (Mojang EULA).

## Commands

| Verb | Purpose |
|------|---------|
| `deploy` | Clone QEMU Ubuntu template, cloud-init static IP, install OpenJDK 25 + Paper + plugins, enable systemd |
| `maintain` | Re-apply unit/`server.properties`/`whitelist.json`/`ops.json`/plugins; optional Paper refresh; guest Linux baseline |
| `query` | Config summary; `--live` for `systemctl` + TCP 25565 (+ BlueMap `:8100` when enabled) |
| `health` | DNS + direct TCP 25565; BlueMap TCP + public HTTPS when enabled |
| `teardown` | Destroy QEMU guest |

```bash
hdc run service minecraft deploy -- --instance a
hdc run service minecraft maintain -- --skip-upgrade
hdc run service minecraft query -- --live
hdc run service minecraft teardown -- --instance a --dry-run
```

### Deploy flags

`--instance`, `--system-id`, `--destroy-existing`, `--skip-provision`, `--skip-install`, `--skip-existing`, `--redeploy-existing`

### Maintain flags

`--skip-upgrade` (keep existing **Paper** jar; still download missing plugin jars), `--skip-clamav`, `--skip-admin-user`, `--skip-resources`, `--no-reboot`, `--reboot`, `--dry-run`, `--no-report`

## Ports

| Protocol | Port | Clients |
|----------|------|---------|
| TCP | `25565` | Java Edition |
| UDP | `19132` | Bedrock / Windows Minecraft (Geyser) |
| TCP | `8100` | BlueMap web (LAN; nginx-waf publishes HTTPS) |

LAN: `minecraft-a.hdc.dukk.org:25565`. Public play: `minecraft.dukk.org:25565` after UniFi PF + DNS-only Cloudflare. Map: `https://minecraft.dukk.org`.

Heap defaults: `-Xms2G -Xmx5G` on an 8 GiB VM (`minecraft.java_heap_min` / `java_heap`).

Gameplay identity: `minecraft.motd`, `max_players`, `online_mode`, optional `whitelist` (+ `enforce` + `players[]` via `{ "$hdc.include": "whitelist.json" }`), `ops[]`, and extra `server.properties` keys (`difficulty`, `view-distance`, `simulation-distance`, `enable-query`, …). Keep `prevent-proxy-connections` **false** on standalone Paper behind UniFi hairpin/LAN (Java kick `Failed to verify username!` when Mojang sees WAN IP and Paper sees LAN). Leave `online_mode` true. Optional Paper 26 world-defaults: `paper.per_player_mob_spawns`, `paper.keep_spawn_loaded_range`, `paper.anti_xray` (legacy `paper.yml` does not map 1:1). Whitelist `players[]` may set `"edition": "bedrock"` (Xbox gamertag `name`, optional `xuid` / Floodgate `uuid`); `/whitelist add` is Java-only. Deploy/maintain resolve missing Floodgate UUIDs, write Paper `whitelist.json` with the Floodgate username prefix (default `.`), and set Paper `perform-username-validation: false` so `.Gamertag` can join. Plugin jars download from GitHub / Modrinth / Hangar / LuckPerms metadata / CurseForge (cfwidget); Chunky uses the **bukkit** loader, not Fabric.

No vault secrets for v1.

## Related

- Schema: [`minecraft.config.schema.json`](../../../hdc/apps/hdc-cli/schema/minecraft.config.schema.json)
