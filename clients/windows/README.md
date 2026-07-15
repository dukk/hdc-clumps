# Home Windows clients (`windows`)

Disk usage and Windows Update maintenance for PCs listed in [`config.json`](config.json), via WinRM. Can send Wake-on-LAN when a host is offline. Optional **Ollama as a Windows service** (standalone zip + NSSM) when `hosts[].ollama.enabled` is true.

## Prerequisites

- **Config:** [`config.json`](config.json) from [`config.example.json`](config.example.json).
- **Inventory:** `inventory/manual/systems/*.json` with `automation_targets: ["client"]` and `access.nodes[].winrm`.
- **Vault:** `HDC_WINRM_USER_PASSWORD` (shared); optional per-host `HDC_WINRM_PASSWORD_<SUFFIX>` via `winrm_password_vault_suffix`.
- **Env:** `HDC_WINRM_USER` — for Microsoft accounts (MSA) use `MicrosoftAccount\you@outlook.com`; mixed deployments can set `auth.winrm_user` or `auth.winrm_user_env` per host (see [client-winrm.md](../../../docs/manually-deployed/client-winrm.md)).
- **WinRM:** auto-enabled via PsExec when port 5986 is closed (see [client-winrm.md](../../../docs/manually-deployed/client-winrm.md)); or configure manually.
- **PsExec:** Sysinternals [PsExec](https://learn.microsoft.com/en-us/sysinternals/downloads/psexec) on the operator PC (`PATH`, `HDC_PSEXEC_PATH`, or `winrm_bootstrap.psexec_path`).

## Commands

| Verb | Purpose |
|------|---------|
| `maintain` | Disk report + updates (PSWindowsUpdate); optional reboot; ensure Ollama service when enabled |
| `query` | Disk + pending update count; Ollama service/API status when enabled |

```bash
node apps/hdc-cli/cli.mjs run client windows query --
node apps/hdc-cli/cli.mjs run client windows maintain -- --host-id pc-example
node apps/hdc-cli/cli.mjs help run client windows
```

## Common flags

`--host-id <id>`, `--dry-run`, `--skip-updates`, `--reboot`, `--no-wol`, `--no-winrm-bootstrap`, `--skip-ollama`, `--ollama-only`, `--ollama-start`, `--ollama-models-only`, `--no-report`, `--report <path>`.

- `--ollama-only` — skip Windows Update; install/ensure Ollama only (WinRM, or MeshCentral fallback).
- `--ollama-start` — force-start the Ollama service and probe `/api/tags` (schedule override).
- `--ollama-models-only` — pull `hosts[].ollama.models[]` without reinstall (WinRM sync; MeshCentral schtasks when WinRM is down).

WoL settings: `wol` in this clump config ([`client-wol.md`](../../../docs/manually-deployed/client-wol.md)).

## Ollama Windows service

The desktop `OllamaSetup.exe` installer only starts a **user-session** tray app. For a real Windows service, hdc uses the official **standalone zip** (`ollama-windows-amd64.zip`) plus [NSSM](https://nssm.cc/) (winget when available, otherwise a direct zip download — needed for SYSTEM/MeshCentral installs without winget).

Enable per host in `config.json`:

```json
"ollama": {
  "enabled": true,
  "listen": "0.0.0.0",
  "models": ["llama3.2:latest"],
  "install_dir": "C:\\Program Files\\Ollama",
  "models_dir": "C:\\ProgramData\\Ollama\\models",
  "service_name": "Ollama",
  "schedule": {
    "enabled": true,
    "start_local": "23:00",
    "stop_local": "08:00"
  }
}
```

Optional: `version` (GitHub tag, e.g. `v0.32.0`; omit for latest), `origins` (`OLLAMA_ORIGINS`), `include_rocm` / `include_mlx` for GPU zip overlays.

When `schedule.enabled` is true, the service uses **manual** start; Task Scheduler tasks `HDC-Ollama-Start` / `HDC-Ollama-Stop` run at `start_local` / `stop_local` (local clock; overnight windows like 23:00→08:00 are supported). Inbound TCP **11434** is allowed via Windows Firewall. Outside the window, maintain may start the service temporarily to pull models, then stop it again.

```bash
# Local elevated install on a PC (no hdc/WinRM):
powershell -ExecutionPolicy Bypass -File clumps/clients/windows/scripts/Install-OllamaService.ps1

# Via hdc after enabling ollama on a host:
node apps/hdc-cli/cli.mjs run client windows maintain -- --host-id pc-example --ollama-only
node apps/hdc-cli/cli.mjs run client windows maintain -- --host-id pc-example --ollama-start
node apps/hdc-cli/cli.mjs run client windows maintain -- --host-id pc-example --ollama-models-only
node apps/hdc-cli/cli.mjs run client windows query -- --host-id pc-example
```

Script path: [`scripts/Install-OllamaService.ps1`](scripts/Install-OllamaService.ps1). Maintain stops conflicting tray/startup Ollama instances so they do not fight over port 11434.

Daily `hdc maintain daily` still runs Windows clients as **query only** — Ollama install/upgrade runs only on explicit `hdc run client windows maintain`.

## After deploy / Using the service

No hdc deploy step. Use the PC normally; run `maintain` on a schedule or after patches.

1. Target must be reachable on WinRM (typical `https://<ip>:5986`). If not, hdc bootstraps WinRM via PsExec when enabled (operator admin on the PC).
2. `query` returns JSON on stdout for scripting.
3. `--reboot` only on `maintain` when you accept a restart.

## Related

- [Clients overview](../README.md)
- [AGENTS.md — Home clients](../../../AGENTS.md)
