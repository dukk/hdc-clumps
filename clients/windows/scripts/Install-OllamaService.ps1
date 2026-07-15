<#
.SYNOPSIS
  Install Ollama standalone CLI as a Windows service via NSSM.

.DESCRIPTION
  Downloads ollama-windows-amd64.zip from GitHub releases (not OllamaSetup.exe),
  installs under Program Files, registers an NSSM-managed service that runs
  `ollama serve`, and optionally pulls models.

  Idempotent: safe to re-run for upgrades and desired-state reconcile.

.PARAMETER Version
  Release tag (e.g. v0.32.0). Empty = latest GitHub release.

.PARAMETER InstallDir
  Directory for ollama.exe and GPU libs. Default: C:\Program Files\Ollama

.PARAMETER ModelsDir
  OLLAMA_MODELS path. Default: C:\ProgramData\Ollama\models

.PARAMETER ServiceName
  Windows service name. Default: Ollama

.PARAMETER ListenHost
  OLLAMA_HOST value. Default: 0.0.0.0

.PARAMETER Origins
  Optional OLLAMA_ORIGINS value (e.g. *).

.PARAMETER Models
  Model tags to `ollama pull` after the service is healthy.

.PARAMETER IncludeRocm
  Also extract ollama-windows-amd64-rocm.zip into InstallDir.

.PARAMETER IncludeMlx
  Also extract ollama-windows-amd64-mlx.zip into InstallDir.

.PARAMETER DryRun
  Print planned actions without changing the system.

.PARAMETER SkipModels
  Skip model pulls even when -Models is set.

.PARAMETER StatusOnly
  Report service/API status as JSON and exit (no install).

.PARAMETER ScheduleEnabled
  When set, service is demand-start and Task Scheduler starts/stops it on a local daily window.

.PARAMETER ScheduleStart
  Local start time HH:mm (default 23:00). Inclusive start of the run window.

.PARAMETER ScheduleStop
  Local stop time HH:mm (default 08:00). Exclusive end of the run window (overnight windows supported).
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$InstallDir = 'C:\Program Files\Ollama',
  [string]$ModelsDir = 'C:\ProgramData\Ollama\models',
  [string]$ServiceName = 'Ollama',
  [string]$ListenHost = '0.0.0.0',
  [string]$Origins = '',
  [string[]]$Models = @(),
  [switch]$IncludeRocm,
  [switch]$IncludeMlx,
  [switch]$DryRun,
  [switch]$SkipModels,
  [switch]$StatusOnly,
  [switch]$ScheduleEnabled,
  [string]$ScheduleStart = '23:00',
  [string]$ScheduleStop = '08:00'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-HdcLog {
  param([string]$Message)
  [Console]::Error.WriteLine("[hdc-ollama] $Message")
}

function Test-IsAdministrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Parse-ScheduleTimeOfDay {
  param([string]$Text)
  $t = [string]$Text
  if (-not $t -or -not $t.Trim()) { throw 'schedule time is empty' }
  $dto = [datetime]::ParseExact($t.Trim(), 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  return $dto.TimeOfDay
}

function Test-InOllamaScheduleWindow {
  param(
    [string]$StartText,
    [string]$StopText,
    [datetime]$Now = (Get-Date)
  )
  $start = Parse-ScheduleTimeOfDay -Text $StartText
  $stop = Parse-ScheduleTimeOfDay -Text $StopText
  $tod = $Now.TimeOfDay
  if ($start -eq $stop) { return $true }
  if ($start -lt $stop) {
    return ($tod -ge $start -and $tod -lt $stop)
  }
  # Overnight window (e.g. 23:00 → 08:00)
  return ($tod -ge $start -or $tod -lt $stop)
}

function Get-OllamaStatusObject {
  param(
    [string]$SvcName,
    [string]$BinDir,
    [bool]$ScheduleOn = $false,
    [string]$SchedStart = '23:00',
    [string]$SchedStop = '08:00'
  )
  $exe = Join-Path $BinDir 'ollama.exe'
  $svc = Get-Service -Name $SvcName -ErrorAction SilentlyContinue
  $apiOk = $false
  $modelNames = @()
  $versionOut = $null
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
      $apiOk = $true
      $json = $resp.Content | ConvertFrom-Json
      if ($json.models) {
        $modelNames = @($json.models | ForEach-Object { $_.name })
      }
    }
  } catch {
    $apiOk = $false
  }
  if (Test-Path -LiteralPath $exe) {
    try {
      $versionOut = (& $exe --version 2>&1 | Out-String).Trim()
    } catch {
      $versionOut = $null
    }
  }
  $inWindow = if ($ScheduleOn) {
    Test-InOllamaScheduleWindow -StartText $SchedStart -StopText $SchedStop
  } else {
    $true
  }
  $taskStart = Get-ScheduledTask -TaskName 'HDC-Ollama-Start' -ErrorAction SilentlyContinue
  $taskStop = Get-ScheduledTask -TaskName 'HDC-Ollama-Stop' -ErrorAction SilentlyContinue
  $runningOk = ($null -ne $svc -and $svc.Status -eq 'Running' -and $apiOk)
  $scheduledIdleOk = (
    $ScheduleOn -and -not $inWindow -and
    ($null -ne $svc) -and
    (Test-Path -LiteralPath $exe) -and
    ($null -ne $taskStart) -and ($null -ne $taskStop)
  )
  return [ordered]@{
    ok                 = ($runningOk -or $scheduledIdleOk)
    service_name       = $SvcName
    service_exists     = ($null -ne $svc)
    service_status     = if ($svc) { [string]$svc.Status } else { 'Missing' }
    install_dir        = $BinDir
    binary_present     = (Test-Path -LiteralPath $exe)
    version            = $versionOut
    api_ok             = $apiOk
    models             = $modelNames
    schedule_enabled   = $ScheduleOn
    schedule_start     = if ($ScheduleOn) { $SchedStart } else { $null }
    schedule_stop      = if ($ScheduleOn) { $SchedStop } else { $null }
    in_schedule_window = $inWindow
    schedule_tasks     = [ordered]@{
      start = ($null -ne $taskStart)
      stop  = ($null -ne $taskStop)
    }
  }
}

function Resolve-OllamaReleaseTag {
  param([string]$Requested)
  if ($Requested -and $Requested.Trim()) {
    $t = $Requested.Trim()
    if ($t -notmatch '^v') { $t = "v$t" }
    return $t
  }
  Write-HdcLog 'Resolving latest Ollama release tag…'
  $headers = @{
    'User-Agent' = 'hdc-Install-OllamaService'
    'Accept'     = 'application/vnd.github+json'
  }
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/ollama/ollama/releases/latest' -Headers $headers
  if (-not $rel.tag_name) {
    throw 'Could not resolve latest Ollama release tag from GitHub'
  }
  return [string]$rel.tag_name
}

function Get-NssmPath {
  $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    Join-Path ${env:ProgramFiles} 'nssm\nssm.exe'
    Join-Path ${env:ProgramFiles(x86)} 'nssm\nssm.exe'
    Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\nssm.exe'
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  # WinGet package layout varies by arch/version
  $wingetRoots = @(
    Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    Join-Path ${env:ProgramFiles} 'WinGet\Packages'
  )
  foreach ($root in $wingetRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $found = Get-ChildItem -Path $root -Filter nssm.exe -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

function Install-NssmFromZip {
  # Pre-release 2.24-101+ preferred on Win10 1703+ / Win11 (stable 2.24 can fail to start services).
  # SYSTEM sessions often lack winget (per-user App Installer), so download the official zip.
  param(
    [string]$DestDir = (Join-Path ${env:ProgramFiles} 'nssm'),
    [string[]]$Urls = @(
      'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip',
      'https://nssm.cc/release/nssm-2.24.zip'
    )
  )
  $lastError = $null
  foreach ($Url in $Urls) {
    Write-HdcLog "Downloading NSSM from $Url"
    $tmp = Join-Path $env:TEMP ("hdc-nssm-" + [guid]::NewGuid().ToString('n') + '.zip')
    $extract = Join-Path $env:TEMP ("hdc-nssm-" + [guid]::NewGuid().ToString('n'))
    $attempt = 0
    while ($attempt -lt 3) {
      $attempt++
      try {
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
        New-Item -ItemType Directory -Path $extract -Force | Out-Null
        Expand-Archive -LiteralPath $tmp -DestinationPath $extract -Force
        $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
        $src = Get-ChildItem -Path $extract -Filter nssm.exe -Recurse -ErrorAction SilentlyContinue |
          Where-Object { $_.DirectoryName -match [regex]::Escape($arch) } |
          Select-Object -First 1
        if (-not $src) {
          $src = Get-ChildItem -Path $extract -Filter nssm.exe -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        }
        if (-not $src) { throw "nssm.exe not found inside $Url" }
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
        $dest = Join-Path $DestDir 'nssm.exe'
        Copy-Item -LiteralPath $src.FullName -Destination $dest -Force
        Write-HdcLog "NSSM installed: $dest"
        return $dest
      } catch {
        $lastError = $_
        Write-HdcLog "NSSM download attempt $attempt failed: $($_.Exception.Message)"
        Start-Sleep -Seconds (5 * $attempt)
      } finally {
        if (Test-Path -LiteralPath $tmp) {
          Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $extract) {
          Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }
  throw "NSSM zip install failed after retries: $($lastError.Exception.Message)"
}

function Ensure-Nssm {
  param([switch]$DryRun)
  $existing = Get-NssmPath
  if ($existing) {
    Write-HdcLog "NSSM found: $existing"
    return $existing
  }
  if ($DryRun) {
    Write-HdcLog 'dry-run: would install NSSM via winget or https://nssm.cc/ zip'
    return 'nssm.exe'
  }
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    Write-HdcLog 'NSSM not found; installing via winget…'
    & winget.exe install -e --id NSSM.NSSM --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
      # -1978335189 = already installed (winget)
      Write-HdcLog "winget install NSSM.NSSM failed (exit $LASTEXITCODE); falling back to zip download"
    } else {
      $path = Get-NssmPath
      if ($path) { return $path }
      Write-HdcLog 'winget reported success but nssm.exe not on PATH; falling back to zip download'
    }
  } else {
    Write-HdcLog 'NSSM not found and winget.exe unavailable (common under SYSTEM); downloading zip…'
  }
  return Install-NssmFromZip
}

function Stop-OllamaUserProcesses {
  $names = @('ollama app', 'ollama', 'Ollama')
  foreach ($n in $names) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
      Write-HdcLog "Stopping process $($_.ProcessName) (pid $($_.Id))"
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

function Disable-OllamaUserStartup {
  # Desktop installer registers a Startup shortcut / Run key — disable to avoid port fights.
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (Test-Path -LiteralPath $runKey) {
    $props = Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
    foreach ($name in @('Ollama', 'ollama')) {
      if ($props -and $null -ne $props.$name) {
        Write-HdcLog "Removing HKCU Run entry: $name"
        Remove-ItemProperty -LiteralPath $runKey -Name $name -ErrorAction SilentlyContinue
      }
    }
  }
  $startupDir = [Environment]::GetFolderPath('Startup')
  if ($startupDir) {
    Get-ChildItem -LiteralPath $startupDir -Filter '*ollama*' -ErrorAction SilentlyContinue | ForEach-Object {
      Write-HdcLog "Removing Startup shortcut: $($_.FullName)"
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

function Expand-OllamaZip {
  param(
    [string]$Url,
    [string]$DestDir,
    [string]$Label,
    [switch]$DryRun
  )
  Write-HdcLog "Downloading $Label from $Url"
  if ($DryRun) {
    Write-HdcLog "dry-run: would extract $Label into $DestDir"
    return
  }
  $tmp = Join-Path $env:TEMP ("hdc-ollama-" + [guid]::NewGuid().ToString('n') + '.zip')
  try {
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    if (-not (Test-Path -LiteralPath $DestDir)) {
      New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    }
    Expand-Archive -LiteralPath $tmp -DestinationPath $DestDir -Force
  } finally {
    if (Test-Path -LiteralPath $tmp) {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
}

function Ensure-OllamaService {
  param(
    [string]$NssmPath,
    [string]$SvcName,
    [string]$ExePath,
    [string]$AppDir,
    [string]$ModelsPath,
    [string]$HostValue,
    [string]$OriginsValue,
    [switch]$DemandStart,
    [switch]$DryRun
  )
  $exe = $ExePath
  if ($DryRun) {
    Write-HdcLog "dry-run: would ensure service $SvcName -> $exe serve (demand_start=$DemandStart)"
    return
  }
  $existing = Get-Service -Name $SvcName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-HdcLog "Creating service $SvcName via NSSM"
    & $NssmPath install $SvcName $exe serve
    if ($LASTEXITCODE -ne 0) { throw "nssm install failed with exit code $LASTEXITCODE" }
  } else {
    Write-HdcLog "Updating service $SvcName paths via NSSM"
    & $NssmPath set $SvcName Application $exe | Out-Null
    & $NssmPath set $SvcName AppParameters serve | Out-Null
  }
  & $NssmPath set $SvcName AppDirectory $AppDir | Out-Null
  & $NssmPath set $SvcName DisplayName 'Ollama' | Out-Null
  & $NssmPath set $SvcName Description 'Ollama LLM server (hdc-managed)' | Out-Null
  if ($DemandStart) {
    & $NssmPath set $SvcName Start SERVICE_DEMAND_START | Out-Null
  } else {
    & $NssmPath set $SvcName Start SERVICE_AUTO_START | Out-Null
  }
  & $NssmPath set $SvcName AppStdout (Join-Path $env:ProgramData 'Ollama\logs\service-stdout.log') | Out-Null
  & $NssmPath set $SvcName AppStderr (Join-Path $env:ProgramData 'Ollama\logs\service-stderr.log') | Out-Null
  & $NssmPath set $SvcName AppRotateFiles 1 | Out-Null
  & $NssmPath set $SvcName AppRotateBytes 10485760 | Out-Null
  & $NssmPath set $SvcName AppExit Default Restart | Out-Null
  & $NssmPath set $SvcName AppRestartDelay 5000 | Out-Null

  # NSSM AppEnvironmentExtra: pass each NAME=VALUE as a separate argument
  $envArgs = @(
    "OLLAMA_HOST=$HostValue"
    "OLLAMA_MODELS=$ModelsPath"
  )
  if ($OriginsValue -and $OriginsValue.Trim()) {
    $envArgs += "OLLAMA_ORIGINS=$($OriginsValue.Trim())"
  }
  & $NssmPath set $SvcName AppEnvironmentExtra @envArgs | Out-Null
}

function Ensure-OllamaFirewallRule {
  param(
    [int]$Port = 11434,
    [switch]$DryRun
  )
  $ruleName = 'HDC Ollama 11434'
  Write-HdcLog "Ensuring firewall rule $ruleName (TCP $Port inbound)"
  if ($DryRun) {
    Write-HdcLog "dry-run: would ensure firewall allow TCP $Port"
    return
  }
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue | Out-Null
  } else {
    New-NetFirewallRule `
      -DisplayName $ruleName `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $Port `
      -Profile Any `
      -ErrorAction Stop | Out-Null
  }
}

function Ensure-OllamaScheduleTasks {
  param(
    [string]$SvcName,
    [string]$StartText,
    [string]$StopText,
    [switch]$Enabled,
    [switch]$DryRun
  )
  $startName = 'HDC-Ollama-Start'
  $stopName = 'HDC-Ollama-Stop'
  if (-not $Enabled) {
    Write-HdcLog 'Schedule disabled; removing HDC Ollama scheduled tasks if present'
    if (-not $DryRun) {
      Unregister-ScheduledTask -TaskName $startName -Confirm:$false -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $stopName -Confirm:$false -ErrorAction SilentlyContinue
    }
    return
  }
  Write-HdcLog "Ensuring schedule tasks $startName@$StartText / $stopName@$StopText"
  if ($DryRun) {
    Write-HdcLog 'dry-run: would register Ollama start/stop scheduled tasks'
    return
  }
  $startAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"Start-Service -Name '$SvcName'`""
  $stopAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"Stop-Service -Name '$SvcName' -Force -ErrorAction SilentlyContinue`""
  $startTrigger = New-ScheduledTaskTrigger -Daily -At $StartText
  $stopTrigger = New-ScheduledTaskTrigger -Daily -At $StopText
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

  Unregister-ScheduledTask -TaskName $startName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $stopName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $startName -Action $startAction -Trigger $startTrigger -Principal $principal -Settings $settings -Force | Out-Null
  Register-ScheduledTask -TaskName $stopName -Action $stopAction -Trigger $stopTrigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Wait-OllamaApi {
  param([int]$TimeoutSeconds = 90)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) { return $true }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

function Sync-OllamaModels {
  param(
    [string]$ExePath,
    [string[]]$Wanted,
    [switch]$DryRun
  )
  if (-not $Wanted -or $Wanted.Count -eq 0) { return @() }
  $results = @()
  foreach ($m in $Wanted) {
    $name = [string]$m
    if (-not $name.Trim()) { continue }
    Write-HdcLog "Pulling model $name"
    if ($DryRun) {
      $results += [ordered]@{ name = $name; action = 'dry_run_pull' }
      continue
    }
    & $ExePath pull $name
    if ($LASTEXITCODE -ne 0) {
      throw "ollama pull $name failed with exit code $LASTEXITCODE"
    }
    $results += [ordered]@{ name = $name; action = 'pulled' }
  }
  return $results
}

# --- main ---

$scheduleOn = [bool]$ScheduleEnabled
$schedStart = if ($ScheduleStart -and $ScheduleStart.Trim()) { $ScheduleStart.Trim() } else { '23:00' }
$schedStop = if ($ScheduleStop -and $ScheduleStop.Trim()) { $ScheduleStop.Trim() } else { '08:00' }
if ($scheduleOn) {
  # Validate times early
  [void](Parse-ScheduleTimeOfDay -Text $schedStart)
  [void](Parse-ScheduleTimeOfDay -Text $schedStop)
}

if ($StatusOnly) {
  $status = Get-OllamaStatusObject -SvcName $ServiceName -BinDir $InstallDir -ScheduleOn:$scheduleOn -SchedStart $schedStart -SchedStop $schedStop
  $status | ConvertTo-Json -Compress -Depth 5
  if (-not $status.ok) { exit 1 }
  exit 0
}

if (-not (Test-IsAdministrator)) {
  throw 'Install-OllamaService.ps1 must run elevated (Administrator)'
}

$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
if ($build -lt 19045) {
  # Windows 10 22H2 = 19045
  Write-HdcLog "Warning: OS build $build is below Windows 10 22H2 (19045); Ollama may not be supported"
}

$tag = Resolve-OllamaReleaseTag -Requested $Version
Write-HdcLog "Using Ollama release $tag"
$baseUrl = "https://github.com/ollama/ollama/releases/download/$tag"

$exePath = Join-Path $InstallDir 'ollama.exe'
$logDir = Join-Path $env:ProgramData 'Ollama\logs'

if ($DryRun) {
  Write-HdcLog "dry-run: install_dir=$InstallDir models_dir=$ModelsDir service=$ServiceName listen=$ListenHost schedule=$scheduleOn ($schedStart-$schedStop)"
} else {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

Write-HdcLog 'Stopping conflicting user-session Ollama processes…'
if (-not $DryRun) {
  # Stop the NSSM service first so Expand-Archive can overwrite ollama.exe.
  # Stopping only processes races NSSM auto-restart during the zip download.
  $svcExisting = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svcExisting) {
    Write-HdcLog "Stopping service $ServiceName before upgrade"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Stop-OllamaUserProcesses
  Disable-OllamaUserStartup
  # Second pass after process kill — NSSM may have restarted briefly.
  $svcExisting = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svcExisting -and $svcExisting.Status -eq 'Running') {
    Write-HdcLog "Service $ServiceName still running; force stop again"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Stop-OllamaUserProcesses
  }
}

Expand-OllamaZip -Url "$baseUrl/ollama-windows-amd64.zip" -DestDir $InstallDir -Label 'ollama-windows-amd64.zip' -DryRun:$DryRun
if ($IncludeRocm) {
  Expand-OllamaZip -Url "$baseUrl/ollama-windows-amd64-rocm.zip" -DestDir $InstallDir -Label 'ollama-windows-amd64-rocm.zip' -DryRun:$DryRun
}
if ($IncludeMlx) {
  Expand-OllamaZip -Url "$baseUrl/ollama-windows-amd64-mlx.zip" -DestDir $InstallDir -Label 'ollama-windows-amd64-mlx.zip' -DryRun:$DryRun
}

if (-not $DryRun -and -not (Test-Path -LiteralPath $exePath)) {
  throw "ollama.exe not found after extract at $exePath"
}

$nssm = Ensure-Nssm -DryRun:$DryRun
Ensure-OllamaService `
  -NssmPath $nssm `
  -SvcName $ServiceName `
  -ExePath $exePath `
  -AppDir $InstallDir `
  -ModelsPath $ModelsDir `
  -HostValue $ListenHost `
  -OriginsValue $Origins `
  -DemandStart:$scheduleOn `
  -DryRun:$DryRun

Ensure-OllamaFirewallRule -Port 11434 -DryRun:$DryRun
Ensure-OllamaScheduleTasks `
  -SvcName $ServiceName `
  -StartText $schedStart `
  -StopText $schedStop `
  -Enabled:$scheduleOn `
  -DryRun:$DryRun

$inWindow = if ($scheduleOn) {
  Test-InOllamaScheduleWindow -StartText $schedStart -StopText $schedStop
} else {
  $true
}

$modelResults = @()
if (-not $DryRun) {
  $needApi = (-not $SkipModels -and $Models -and $Models.Count -gt 0) -or $inWindow
  if ($needApi) {
    Write-HdcLog "Starting service $ServiceName (in_window=$inWindow)"
    Start-Service -Name $ServiceName
    if (-not (Wait-OllamaApi -TimeoutSeconds 120)) {
      throw "Service $ServiceName started but API at http://127.0.0.1:11434 did not become ready"
    }
    Write-HdcLog 'Ollama API is healthy'
    if (-not $SkipModels -and $Models -and $Models.Count -gt 0) {
      $modelResults = @(Sync-OllamaModels -ExePath $exePath -Wanted $Models -DryRun:$DryRun)
    }
  } else {
    Write-HdcLog "Outside schedule window ($schedStart-$schedStop); leaving service stopped after install"
  }
  if ($scheduleOn -and -not $inWindow) {
    $svcNow = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svcNow -and $svcNow.Status -eq 'Running') {
      Write-HdcLog "Stopping $ServiceName to honor night schedule (outside window)"
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
  }
} else {
  Write-HdcLog "dry-run: would start service as needed (in_window=$inWindow) and probe API"
  if (-not $SkipModels -and $Models -and $Models.Count -gt 0) {
    $modelResults = @(Sync-OllamaModels -ExePath $exePath -Wanted $Models -DryRun)
  }
}

$status = if ($DryRun) {
  [ordered]@{
    ok             = $true
    dry_run        = $true
    version_tag    = $tag
    install_dir    = $InstallDir
    models_dir     = $ModelsDir
    service_name   = $ServiceName
    listen         = $ListenHost
    models_planned = $Models
    schedule_enabled = $scheduleOn
    schedule_start = if ($scheduleOn) { $schedStart } else { $null }
    schedule_stop  = if ($scheduleOn) { $schedStop } else { $null }
    in_schedule_window = $inWindow
  }
} else {
  $s = Get-OllamaStatusObject -SvcName $ServiceName -BinDir $InstallDir -ScheduleOn:$scheduleOn -SchedStart $schedStart -SchedStop $schedStop
  $s['version_tag'] = $tag
  $s['models_dir'] = $ModelsDir
  $s['listen'] = $ListenHost
  $s['model_actions'] = $modelResults
  $s
}

$status | ConvertTo-Json -Compress -Depth 6
if (-not $status.ok -and -not $DryRun) { exit 1 }
exit 0
