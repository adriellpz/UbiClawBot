<#
.SYNOPSIS
  Upsert a Cloudflare DNS record (same API flarectl uses).

.PARAMETER ZoneName
  Apex zone, e.g. sonofwolf.org

.PARAMETER RecordName
  Subdomain label or FQDN, e.g. ai  ->  ai.<ZoneName>

.PARAMETER Content
  A record IPv4 (default: DigitalOcean droplet for OpenClaw).

.PARAMETER Proxied
  $false = DNS only (gray cloud), best for direct A -> VPS + Caddy/Let's Encrypt on the box.
  $true  = orange cloud; needs valid TLS on origin for Full (strict).

Auth (pick one):
  - $env:CF_API_TOKEN = API token for this zone
  - Or .env.cf (gitignored) with line: CF_API_TOKEN=...

Token permissions (custom token):
  - Zone > Zone > Read   (required to resolve zone id)
  - Zone > DNS > Edit   (required to create/update records)
  Scope to zone: $ZoneName (or All zones).

Optional: install flarectl for similar ops: go install github.com/cloudflare/cloudflare-go/cmd/flarectl@latest

Tunnel (browser login once):  .\bin\cloudflared.exe tunnel login
#>
[CmdletBinding()]
param(
  [string] $ZoneName = "sonofwolf.org",
  [string] $RecordName = "ai",
  [string] $Content = "134.209.38.222",
  [bool] $Proxied = $false
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tokenFile = Join-Path $root ".env.cf"
$Token = $env:CF_API_TOKEN
if (-not $Token -and (Test-Path $tokenFile)) {
  $line = Get-Content $tokenFile -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^\s*CF_API_TOKEN\s*=' -and $_ -notmatch '^\s*#' } |
    Select-Object -First 1
  if ($line) {
    $Token = ($line -replace '^\s*CF_API_TOKEN\s*=\s*', "").Trim().Trim('"').Trim("'")
  }
}
if ($Token -match 'PASTE_|REPLACE_ME|YOUR_TOKEN|example\.com' -or $Token.Length -lt 24) {
  throw @"
CF_API_TOKEN in .env.cf still looks like a placeholder or is too short.
Edit $tokenFile : set CF_API_TOKEN=<your real Cloudflare API token> (one line, no spaces around =).
Then run this script again.
"@
}

if (-not $Token) {
  Write-Host @"
Missing Cloudflare API token.

1) Dashboard: https://dash.cloudflare.com/profile/api-tokens
   Create token with: Zone > Zone > Read + Zone > DNS > Edit (zone: $ZoneName)

2) Then either:
   `$env:CF_API_TOKEN = '<paste>'`
   or create $tokenFile with:
   CF_API_TOKEN=<paste>

Re-run: .\cloudflare-upsert-dns.ps1
"@ -ForegroundColor Yellow
  exit 1
}

$fqdn = if ($RecordName -match '\.') { $RecordName.TrimEnd('.') } else { "$RecordName.$ZoneName".ToLowerInvariant() }
$base = "https://api.cloudflare.com/client/v4"

function Invoke-Cf($Method, $Uri, $Body = $null) {
  # Do not send Content-Type on GET (Cloudflare often returns 400 if you do).
  $h = @{ Authorization = "Bearer $Token" }
  $params = @{ Uri = $Uri; Method = $Method; Headers = $h }
  if ($null -ne $Body) {
    $h["Content-Type"] = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 6)
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    $msg = $_.Exception.Message
    try {
      $resp = $_.Exception.Response
      if ($resp -and $resp.GetResponseStream()) {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $msg = $msg + " | " + $sr.ReadToEnd()
      }
    } catch { }
    throw "Cloudflare $Method failed: $msg"
  }
}

$verify = Invoke-Cf GET "$base/user/tokens/verify"
if (-not $verify.success) {
  throw "Token verify failed: $($verify.errors | ConvertTo-Json -Compress)"
}

$zones = Invoke-Cf GET "$base/zones?name=$ZoneName"
$zoneCount = @($zones.result).Count
if (-not $zones.success -or $zoneCount -lt 1) {
  $err = $zones.errors | ConvertTo-Json -Compress
  $msg = $zones.messages | ConvertTo-Json -Compress
  throw @"
Zone not found or no access: $ZoneName
  API success=$($zones.success)  resultCount=$zoneCount
  errors=$err
  messages=$msg

Fixes that usually resolve this:
  - Confirm $ZoneName is added in this Cloudflare account (Websites).
  - Recreate API token with Zone:Zone:Read AND Zone:DNS:Edit for that zone.
  - If the domain uses another DNS host, add the zone to Cloudflare first (change nameservers) or manage DNS where the domain lives.
"@
}
$zoneId = $zones.result[0].id

$list = Invoke-Cf GET "$base/zones/$zoneId/dns_records?type=A&name=$fqdn"
$existing = @($list.result)
$body = @{
  type    = "A"
  name    = $fqdn
  content = $Content
  ttl     = 1
  proxied = $Proxied
}

if ($existing.Count -eq 0) {
  $created = Invoke-Cf POST "$base/zones/$zoneId/dns_records" $body
  if (-not $created.success) { throw ($created.errors | ConvertTo-Json) }
  Write-Host "Created A $fqdn -> $Content (proxied=$Proxied) id=$($created.result.id)" -ForegroundColor Green
  exit 0
}

$r = $existing[0]
if ($r.content -eq $Content -and [bool]$r.proxied -eq $Proxied) {
  Write-Host "Already correct: A $fqdn -> $Content (proxied=$Proxied)" -ForegroundColor Green
  exit 0
}

$updated = Invoke-Cf PUT "$base/zones/$zoneId/dns_records/$($r.id)" $body
if (-not $updated.success) { throw ($updated.errors | ConvertTo-Json) }
Write-Host "Updated A $fqdn -> $Content (proxied=$Proxied) id=$($updated.result.id)" -ForegroundColor Green
