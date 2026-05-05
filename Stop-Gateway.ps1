#Requires -Version 5.1
$Repo = Join-Path $PSScriptRoot "openclaw-repo"
Push-Location $Repo
try { docker compose stop openclaw-gateway }
finally { Pop-Location }
