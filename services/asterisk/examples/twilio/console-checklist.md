# Twilio Console checklist (Asterisk + HDC)

Replace placeholders before use. Do not commit real credentials.

## 1. Elastic SIP Trunk

- [ ] Twilio Console → **Elastic SIP Trunking** → **Create new SIP Trunk**
- [ ] Friendly name: `hdc-asterisk-example`
- [ ] Copy **Termination SIP URI** → `mytrunk.pstn.twilio.com` (example)
- [ ] Set in hdc-private `clumps/services/asterisk/config.json`:

```json
"twilio": {
  "enabled": true,
  "termination_domain": "mytrunk.pstn.twilio.com",
  "trunk_name": "twilio0"
}
```

## 2. Credential List (outbound auth)

- [ ] Trunk → **Termination** → **Credential Lists** → Create list
- [ ] Username: `twilio-sip-user` (example)
- [ ] Password: (strong random; store in vault only)
- [ ] Attach credential list to trunk

```bash
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_SIP_USERNAME
node apps/hdc-cli/cli.mjs secrets set HDC_TWILIO_SIP_PASSWORD
```

## 3. Origination (inbound to Asterisk)

- [ ] Trunk → **Origination** → Add URI(s):

| Priority | Weight | Origination SIP URI |
| --- | --- | --- |
| 10 | 10 | `sip:203.0.113.254:5060;region=us1` |
| 20 | 10 | `sip:203.0.113.254:5060;region=us2` |

Use your **WAN/public IP** (`203.0.113.254` is documentation-only).

- [ ] Set matching NAT in config:

```json
"nat": {
  "enabled": true,
  "local_net": "192.0.2.0/24",
  "external_signaling_address": "203.0.113.254",
  "external_media_address": "203.0.113.254"
}
```

## 4. Phone numbers

- [ ] **Phone Numbers** → Manage → assign number(s) to the Elastic SIP Trunk

## 5. Edge firewall / router

- [ ] Forward **UDP/TCP 5060** → Asterisk guest LAN IP (e.g. `192.0.2.150`)
- [ ] Forward **UDP 10000–20000** → same guest IP (match `rtp_port_min` / `rtp_port_max` in config)

## 6. Apply HDC config

```bash
node apps/hdc-cli/cli.mjs run service asterisk maintain --
node apps/hdc-cli/cli.mjs run service asterisk query -- --live
```

## 7. Smoke tests

- [ ] Outbound: from SIP phone, dial `9` + E.164 (e.g. `9+15551234567`)
- [ ] Inbound: call Twilio DID; hear demo prompt or reach extension `1001`
- [ ] `asterisk -rx "pjsip show endpoint twilio0-endpoint"` shows endpoint OK

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Outbound fast busy | Credentials, `termination_domain`, firewall egress to Twilio |
| Inbound never rings | Origination URI WAN IP, port 5060 forward, NAT `external_*` |
| One-way audio | RTP port range forwarded; `external_media_address` correct |
| 403 / auth errors | Credential list attached to trunk; re-run maintain after vault update |
