#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot bootstrap: isolated OpenClaw gateway (official image) + narrow bind mounts.

.DESCRIPTION
  - Data lives under this folder only (config/ + workspace/), not ~/.openclaw on the host.
  - Uses ghcr.io/openclaw/openclaw:latest (override with OPENCLAW_IMAGE in .env after first run).
  - First run: non-interactive onboard (no LLM keys; add providers in Control UI later).
  - For Docker-socket agent sandboxing (optional), use upstream:
      OPENCLAW_SANDBOX=1 ./scripts/docker/setup.sh
    from Git Bash/WSL in openclaw-repo (mounts docker.sock; see docs).

  Run from PowerShell:  .\Setup.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$Repo = Join-Path $Root "openclaw-repo"
$RepoUrl = "https://github.com/openclaw/openclaw.git"
$ConfigDir = Join-Path $Root "config"
$WorkspaceDir = Join-Path $Root "workspace"
$EnvFile = Join-Path $Repo ".env"

function ConvertTo-DockerBindPath([string]$Path) {
  return ($Path -replace "\\", "/")
}

function New-GatewayTokenHex([int]$Bytes = 32) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $buf = New-Object byte[] $Bytes
  $rng.GetBytes($buf)
  return ([System.BitConverter]::ToString($buf) -replace "-", "").ToLowerInvariant()
}

function Merge-DotEnv {
  param([string]$File, [hashtable]$Pairs)
  $result = New-Object System.Collections.Generic.List[string]
  $found = @{}
  if (Test-Path -LiteralPath $File) {
    foreach ($line in Get-Content -LiteralPath $File -ErrorAction SilentlyContinue) {
      $trim = $line.TrimStart()
      if ($trim -match '^([A-Za-z_][A-Za-z0-9_]*)=') {
        $k = $Matches[1]
        if ($Pairs.ContainsKey($k)) {
          [void]$result.Add("${k}=$($Pairs[$k])")
          $found[$k] = $true
          continue
        }
      }
      [void]$result.Add($line)
    }
  }
  foreach ($k in $Pairs.Keys) {
    if (-not $found[$k]) { [void]$result.Add("${k}=$($Pairs[$k])") }
  }
  Set-Content -LiteralPath $File -Value ($result.ToArray()) -Encoding utf8
}

if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
  Write-Host "Cloning OpenClaw into openclaw-repo ..."
  git clone --depth 1 $RepoUrl $Repo
}

New-Item -ItemType Directory -Force @(
  (Join-Path $ConfigDir "identity")
  (Join-Path $ConfigDir "agents\main\agent")
  (Join-Path $ConfigDir "agents\main\sessions")
  $WorkspaceDir
) | Out-Null

$dockerConfig = ConvertTo-DockerBindPath $ConfigDir
$dockerWorkspace = ConvertTo-DockerBindPath $WorkspaceDir

$token = $null
if (Test-Path -LiteralPath $EnvFile) {
  $m = Select-String -LiteralPath $EnvFile -Pattern '^\s*OPENCLAW_GATEWAY_TOKEN=(.+)$' | Select-Object -Last 1
  if ($m) { $token = $m.Matches[0].Groups[1].Value.Trim() }
}
if (-not $token) { $token = New-GatewayTokenHex }

$image = "ghcr.io/openclaw/openclaw:latest"
if ($env:OPENCLAW_IMAGE) { $image = $env:OPENCLAW_IMAGE }

Merge-DotEnv $EnvFile @{
  OPENCLAW_IMAGE            = $image
  OPENCLAW_CONFIG_DIR       = $dockerConfig
  OPENCLAW_WORKSPACE_DIR    = $dockerWorkspace
  OPENCLAW_GATEWAY_TOKEN    = $token
  OPENCLAW_DISABLE_BONJOUR  = "1"
}

Write-Host "Pulling image: $image"
docker pull $image

Push-Location $Repo
try {
  Write-Host "Fixing bind-mount ownership inside container ..."
  $chownSh = 'find /home/node/.openclaw -xdev -exec chown node:node {} +; [ -d /home/node/.openclaw/workspace/.openclaw ] && chown -R node:node /home/node/.openclaw/workspace/.openclaw || true'
  docker compose run --rm --no-deps --user root --entrypoint sh openclaw-gateway -c $chownSh

  $cfgPath = Join-Path $ConfigDir "openclaw.json"
  if (-not (Test-Path -LiteralPath $cfgPath)) {
    Write-Host "Running first-time onboard (non-interactive, auth skipped - add API keys in UI) ..."
    docker compose run --rm --no-deps --entrypoint node openclaw-gateway dist/index.js onboard `
      --mode local --no-install-daemon --non-interactive --accept-risk --auth-choice skip `
      --gateway-auth token --gateway-token $token `
      --skip-channels --skip-skills --skip-bootstrap --skip-search --skip-health --skip-ui
  } else {
    Write-Host "Skipping onboard (config already present)."
  }

  Write-Host "Starting gateway ..."
  docker compose up -d openclaw-gateway
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "Done."
Write-Host "  Control UI: http://127.0.0.1:18789/"
Write-Host "  Paste token from: $EnvFile (OPENCLAW_GATEWAY_TOKEN)"
Write-Host "  Workspace (host): $WorkspaceDir"
Write-Host "  Playwright shell: .\Run-PlaywrightShell.ps1"
