$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$required = @(
  "server/package.json",
  "server/src/index.ts",
  "server/scripts/init-env.ts",
  "server/scripts/doctor.ts",
  "server/scripts/create-license-keys.ts",
  "deploy/cloud-server/install-ubuntu.sh",
  "deploy/cloud-server/ozon-sjsq-cloud.service",
  "deploy/cloud-server/nginx-api.conf",
  "deploy/cloud-server/postgres-init.sql",
  "deploy-cloud-server.ps1"
)

$missing = @()
foreach ($item in $required) {
  $path = Join-Path $root $item
  if (-not (Test-Path $path)) {
    $missing += $item
  }
}

if ($missing.Count -gt 0) {
  Write-Host "[ERROR] Missing files:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host " - $_" }
  exit 1
}

$migrationDir = Join-Path $root "server/migrations"
if (-not (Test-Path $migrationDir)) {
  throw "Missing server/migrations directory"
}

$migrationFiles = Get-ChildItem -LiteralPath $migrationDir -Filter "*.sql" | Sort-Object Name
if ($migrationFiles.Count -eq 0) {
  throw "server/migrations must contain SQL migration files"
}

$migrationNames = $migrationFiles | ForEach-Object { $_.Name }
if ($migrationNames -notcontains "001_init.sql") {
  throw "server/migrations is missing 001_init.sql"
}
if ($migrationNames -notcontains "005_featured_gallery.sql") {
  throw "server/migrations is missing 005_featured_gallery.sql"
}

$service = Get-Content -Raw (Join-Path $root "deploy/cloud-server/ozon-sjsq-cloud.service")
if ($service -notmatch "WorkingDirectory=/opt/ozon-sjsq-cloud/server") {
  throw "systemd WorkingDirectory is not pointing to /opt/ozon-sjsq-cloud/server"
}

$install = Get-Content -Raw (Join-Path $root "deploy/cloud-server/install-ubuntu.sh")
if ($install -notmatch "unzip") {
  throw "install-ubuntu.sh must install unzip"
}

Write-Host "[OK] Cloud deploy assets are ready."
