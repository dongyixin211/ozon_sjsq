param(
  [Parameter(Mandatory = $true)]
  [string]$SshTarget,

  [string]$RemoteDir = "/opt/ozon-sjsq-cloud",
  [string]$ArchiveName = "ozon-sjsq-cloud-upload.zip",
  [string]$AppUser = "ozoncloud",
  [string]$IdentityFile = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ArchivePath = Join-Path $env:TEMP $ArchiveName
$StageDir = Join-Path $env:TEMP "ozon-sjsq-cloud-stage"

Write-Host "[INFO] Building web user app..."
Push-Location $Root
try {
  npm run build:web
  if ($LASTEXITCODE -ne 0) {
    throw "npm run build:web failed"
  }
}
finally {
  Pop-Location
}

if (Test-Path $StageDir) {
  Remove-Item -LiteralPath $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $StageDir | Out-Null

New-Item -ItemType Directory -Path (Join-Path $StageDir "server") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "deploy") | Out-Null

$excludeDirs = @("node_modules", "reports")
Get-ChildItem -Path (Join-Path $Root "server") -Force | Where-Object {
  $_.Name -notin $excludeDirs -and $_.Name -ne ".env"
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $StageDir "server") -Recurse
}

Copy-Item -LiteralPath (Join-Path $Root "deploy\cloud-server") -Destination (Join-Path $StageDir "deploy") -Recurse

if (Test-Path $ArchivePath) {
  Remove-Item -LiteralPath $ArchivePath -Force
}
Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ArchivePath -Force

$sshArgs = @()
$scpArgs = @()
if ($IdentityFile) {
  $sshArgs += @("-i", $IdentityFile)
  $scpArgs += @("-i", $IdentityFile)
}

function Invoke-NativeChecked {
  param(
    [string]$Name,
    [scriptblock]$Action
  )
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

Write-Host "[INFO] Uploading $ArchivePath to $SshTarget..."
Invoke-NativeChecked "prepare remote directory" {
  ssh @sshArgs $SshTarget "sudo mkdir -p $RemoteDir && sudo chown `$USER:`$USER $RemoteDir"
}
Invoke-NativeChecked "upload archive" {
  scp @scpArgs $ArchivePath "${SshTarget}:/tmp/$ArchiveName"
}
Invoke-NativeChecked "extract archive" {
  ssh @sshArgs $SshTarget "cd $RemoteDir && unzip -o /tmp/$ArchiveName; status=`$?; rm -f /tmp/$ArchiveName; if [ `$status -gt 1 ]; then exit `$status; fi; exit 0"
}
Invoke-NativeChecked "prepare upload storage permissions" {
  ssh @sshArgs $SshTarget "sudo mkdir -p $RemoteDir/uploads/gallery $RemoteDir/uploads/gallery-thumbs && sudo chown -R ${AppUser}:${AppUser} $RemoteDir/uploads && sudo chmod -R u+rwX,g+rwX $RemoteDir/uploads"
}
Invoke-NativeChecked "prepare mockup template permissions" {
  ssh @sshArgs $SshTarget "sudo mkdir -p $RemoteDir/mockup-templates && sudo chown -R ${AppUser}:${AppUser} $RemoteDir/mockup-templates && sudo chmod -R u+rwX,g+rwX $RemoteDir/mockup-templates"
}

Write-Host "[OK] Uploaded to ${SshTarget}:$RemoteDir"
Write-Host "[NEXT] SSH into the server, edit $RemoteDir/server/.env, then run deployment commands from docs."
$global:LASTEXITCODE = 0
