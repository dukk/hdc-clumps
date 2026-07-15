# Twilio Elastic SIP Trunk + Asterisk (HDC)

This folder documents how to connect the **asterisk** HDC package to [Twilio Elastic SIP Trunking](https://www.twilio.com/docs/sip-trunking).

Official references:

- [Twilio Elastic SIP Trunking setup guide](https://www.twilio.com/en-us/blog/elastic-sip-trunking-step-by-step-setup)
- [Sending SIP to Twilio — best practices](https://www.twilio.com/docs/sip-trunking/sending-sip-to-twilio-best-practices)
- [Asterisk + Twilio configuration guide (PDF)](https://www.twilio.com/resources/images/docs/Asterisk-Twilio.pdf)

## Map Twilio Console → HDC config

| Twilio Console | HDC `config.json` field |
| --- | --- |
| Termination SIP URI (e.g. `mytrunk.pstn.twilio.com`) | `asterisk.twilio.termination_domain` |
| Credential List username | vault `HDC_TWILIO_SIP_USERNAME` |
| Credential List password | vault `HDC_TWILIO_SIP_PASSWORD` |
| Optional edge proxy (e.g. `pstn.ashburn.twilio.com`) | `asterisk.twilio.outbound_proxy` |
| Origination context name | `asterisk.twilio.origination.context` (default `from-twilio`) |
| Outbound dial prefix | `asterisk.twilio.termination.dial_prefix` (default `9`) |
| Home WAN IP (NAT) | `asterisk.nat.external_signaling_address` / `external_media_address` |

## Prerequisites

1. **Asterisk guest** deployed via `hdc run service asterisk deploy --`
2. **Public reachability** for inbound: Twilio origination must reach your Asterisk **WAN IP:5060** (UDP/TCP). Forward ports on your edge router — **nginx-waf does not proxy SIP**.
3. **RTP range** (default `10000–20000/udp`) forwarded to the guest IP.
4. **Vault secrets** (names only in config):

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_SIP_USERNAME
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_SIP_PASSWORD
```

5. Re-run maintain after secrets are set:

```bash
node apps/hdc-cli/cli.mjs run service asterisk maintain --
```

## Twilio Console (summary)

See [console-checklist.md](./console-checklist.md) for a step-by-step checklist.

1. **Elastic SIP Trunk** — create trunk; note Termination URI → `termination_domain`.
2. **Credential List** — attach to trunk; store username/password in vault keys above.
3. **Termination** — Asterisk sends outbound calls **to** Twilio using those credentials.
4. **Origination** — add URI `sip:<WAN-IP>:5060;region=us1` (and optional `;region=us2`) so Twilio sends inbound calls **to** Asterisk.
5. **Phone numbers** — attach DID numbers to the trunk.
6. **IP ACL** (optional on Twilio) — restrict who can use your trunk; on Asterisk, `asterisk.twilio.identify_cidrs[]` trusts Twilio signaling IPs for inbound.

## Verify

On the guest (or `query --live`):

```bash
asterisk -rx "pjsip show endpoint twilio0-endpoint"
asterisk -rx "pjsip show registrations"
```

Outbound test (default prefix `9`): dial `9+15551234567` from an internal SIP phone registered as extension `1001`.

Inbound test: call your Twilio number; without a phone configured, the example dialplan plays `demo-congrats` or routes to extension `1001` when `asterisk.endpoints[]` is configured.

## Generated config files

HDC writes (do not edit on server):

- `/etc/asterisk/pjsip.d/hdc-transport.conf`
- `/etc/asterisk/pjsip.d/hdc-twilio-trunk.conf`
- `/etc/asterisk/pjsip.d/hdc-endpoints.conf`
- `/etc/asterisk/extensions.d/hdc-twilio-dialplan.conf`
- `/etc/asterisk/rtp.d/hdc-rtp.conf`

## Secure trunking

TLS/SRTP for Twilio secure trunking is not automated in v1 — use UDP + credential auth as in the example config. Document manual steps if you enable Twilio Secure Trunking later.
