# Slack applications

Registers and maintains the HDC Slack app via the **App Manifest API**. Runtime notifications, Approve/Deny buttons, and manager chat (Events + `/hdc`) live in the hdc CLI / hdc-web-server / hdc-agent-server (see sibling hdc docs).

## Quick start

1. Create App Configuration Tokens at https://api.slack.com/apps  
2. `hdc secrets set HDC_SLACK_CONFIG_TOKEN` and `HDC_SLACK_CONFIG_REFRESH_TOKEN`  
3. Copy `config.example.json` → hdc-private `clumps/infrastructure/slack/config.json`  
4. `hdc run infrastructure slack deploy --`  
5. `hdc run infrastructure slack maintain --` when scopes, Events/slash URLs, or the icon change  
6. Install / reauthorize the app in Slack; set `HDC_SLACK_BOT_TOKEN` and `HDC_SLACK_DECISION_CHANNEL`  
7. Enable `slack-hdc-app` in hdc-agents notifications; `hdc run service hdc-agents maintain --`  
8. Chat: DM the bot, `@mention` it, or `/hdc <prompt>`

Human docs: `hdc/docs/manually-deployed/slack.md` and `manager-notifications.md`.
