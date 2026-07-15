# Twilio (HDC infrastructure)

Read-only inventory of your Twilio account: Elastic SIP trunks (with origination URLs, trunk numbers, credential list usernames) and all Incoming Phone Numbers.

## Secrets

Store API credentials in the hdc vault (never commit):

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_ACCOUNT_SID
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_AUTH_TOKEN
```

Find Account SID and Auth Token in the [Twilio Console](https://console.twilio.com/) (Account → API keys & tokens). SIP trunk **Credential List** passwords are separate vault keys used by the **asterisk** package (`HDC_TWILIO_SIP_USERNAME`, `HDC_TWILIO_SIP_PASSWORD`).

## Config

Copy `config.example.json` to **hdc-private** as `clumps/infrastructure/twilio/config.json`, or bootstrap from the live API:

```bash
node apps/hdc-cli/cli.mjs run infrastructure twilio query -- --import --yes
```

## Query

```bash
node apps/hdc-cli/cli.mjs run infrastructure twilio query --
node apps/hdc-cli/cli.mjs run infrastructure twilio query -- --trunk mytrunk
node apps/hdc-cli/cli.mjs run infrastructure twilio query -- --import --yes
```

See [`docs/manually-deployed/twilio.md`](../../../docs/manually-deployed/twilio.md).
