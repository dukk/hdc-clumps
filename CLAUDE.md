# Claude Code Guidelines — HDC packages (hdc-clumps)

Standards are defined **once**, in `.cursor/rules/` (the canonical source — Cursor's
glob-based rule engine reads it directly), and imported below so Claude Code loads the
identical content. See [AGENTS.md](AGENTS.md) for the repo map and sibling hdc CLI reference.

Cursor auto-attaches each rule only when editing files matching its `globs:`
frontmatter; Claude Code has no equivalent mechanism, so every imported rule below
applies repo-wide for the whole session regardless of scope.

## Always-on standards

@.cursor/rules/hdc-automation.mdc

@.cursor/rules/hdc-inventory-naming.mdc

## Path-specific standards

These carry a `globs:` scope in Cursor (noted per file); Claude Code just applies them
whenever the matching files are actually in play.

@.cursor/rules/hdc-automation-logging.mdc

@.cursor/rules/hdc-homepage-dashboard.mdc

@.cursor/rules/proxmox-qemu-guest-agent.mdc

@.cursor/rules/proxmox-resource-planning.mdc

## Skills

| Skill | Use when |
|-------|----------|
| `hdc-service-deploy` | Deploying a new service package end-to-end (plan → approve → deploy) |
| `proxmox-resource-planning` | Sizing a new Proxmox VM/CT and checking cluster headroom |

Claude Code thin pointers under `.claude/skills/` target the Cursor IDE skills in `.cursor/skills/`.

## Subagents

Thin pointer: [`.claude/agents/hdc-engineer.md`](.claude/agents/hdc-engineer.md) → canonical definition in sibling [hdc `apps/hdc-agent-server/agents/`](../hdc/apps/hdc-agent-server/agents/).

## Quality gate

Run tests from sibling **hdc** after substantive package or CLI changes:

```bash
cd ../hdc
npm install   # devDependencies only (Vitest)
npm run test
```

## Maintaining this file

Adding a new Cursor rule? Add one `@.cursor/rules/<file>.mdc` line above (under
"Always-on" if `alwaysApply: true`, otherwise "Path-specific"). Adding a new Cursor
skill? Add a matching thin-pointer `.claude/skills/<name>/SKILL.md` plus a row in the table above.
