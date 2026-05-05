#Requires -Version 5.1
# Isolated Playwright image with ONLY workspace/ mounted at /workspace.
$Root = $PSScriptRoot
$Workspace = Join-Path $Root "workspace"
$DockerWs = ($Workspace -replace "\\", "/")
$Image = "mcr.microsoft.com/playwright:v1.58.2-noble"

docker run --rm -it `
  -v "${DockerWs}:/workspace" `
  -w /workspace `
  $Image `
  bash
