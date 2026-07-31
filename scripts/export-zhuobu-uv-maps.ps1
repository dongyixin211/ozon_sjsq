param(
  [Parameter(Mandatory = $true)]
  [string]$PsdPath,
  [string]$OutputRoot = "E:\tool\ozon_sjsq\.codex-work\mockup-uv\zhuobu",
  [string]$SourceX = "",
  [string]$SourceY = "",
  [int]$TargetScene = 0
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PsdPath)) {
  throw "PSD file not found: $PsdPath"
}

$OutputRoot = (New-Item -ItemType Directory -Force -Path $OutputRoot).FullName

if (-not $SourceX -or -not $SourceY) {
  node "E:\tool\ozon_sjsq\scripts\create-zhuobu-uv-source-maps.mjs" --output-dir $OutputRoot | Out-Host
  $SourceX = Join-Path $OutputRoot "uv-source-x.png"
  $SourceY = Join-Path $OutputRoot "uv-source-y.png"
}

if (-not (Test-Path -LiteralPath $SourceX)) {
  throw "UV source X not found: $SourceX"
}
if (-not (Test-Path -LiteralPath $SourceY)) {
  throw "UV source Y not found: $SourceY"
}

$jobRoot = "E:\tool\ozon_sjsq\.codex-work"
New-Item -ItemType Directory -Force -Path $jobRoot | Out-Null
$jobPath = Join-Path $jobRoot "zhuobu-uv-current-job.json"
$job = @{
  psdPath = (Resolve-Path -LiteralPath $PsdPath).Path.Replace("\", "/")
  outputDir = $OutputRoot.Replace("\", "/")
  sourceXPath = (Resolve-Path -LiteralPath $SourceX).Path.Replace("\", "/")
  sourceYPath = (Resolve-Path -LiteralPath $SourceY).Path.Replace("\", "/")
  sceneWidth = 800
  sceneHeight = 1067
  targetScene = $TargetScene
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $jobPath -Value $job -Encoding UTF8

$photoshop = New-Object -ComObject Photoshop.Application
$photoshop.Visible = $false
$photoshop.DoJavaScriptFile("E:\tool\ozon_sjsq\scripts\export-zhuobu-uv-maps.jsx")

Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $OutputRoot "uv-report.json")
