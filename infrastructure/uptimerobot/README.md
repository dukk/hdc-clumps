# UptimeRobot (HDC infrastructure)

Manage UptimeRobot monitors, public status pages, and alert contacts via [API v2](https://uptimerobot.com/api/legacy/).

## Secrets

Store the Main API key in the hdc vault (never commit):

```bash
hdc secrets set HDC_UPTIMEROBOT_API_KEY
```

Create the key in UptimeRobot → **Integrations & API** → **API**.

## Config

Copy `config.example.json` to **hdc-private** as `clumps/infrastructure/uptimerobot/config.json`, or bootstrap from the live account:

```bash
hdc run infrastructure uptimerobot query -- --import --yes
```

## Query

```bash
hdc run infrastructure uptimerobot query --
hdc run infrastructure uptimerobot query -- --import --yes
hdc run infrastructure uptimerobot query -- --monitor my-monitor-id
```

## Maintain

Set `managed: true` on entries hdc should create or update. Run a full import before using `--prune` so config lists the complete inventory.

```bash
hdc run infrastructure uptimerobot maintain --
hdc run infrastructure uptimerobot maintain -- --dry-run
hdc run infrastructure uptimerobot maintain -- --prune
```

See [`docs/manually-deployed/uptimerobot.md`](../../../docs/manually-deployed/uptimerobot.md).

Self-hosted LAN monitoring remains in the **uptime-kuma** service package.
