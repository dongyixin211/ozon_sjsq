param(
  [Parameter(Mandatory = $true)]
  [string]$PsdPath,

  [Parameter(Mandatory = $true)]
  [string]$Slug,

  [int]$SceneWidth = 800,

  [int]$SceneHeight = 1067,

  [string]$OutputRoot = 'E:\tool\ozon_sjsq\dist\mockup-convert'
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PsdPath)) {
  throw "PSD file not found: $PsdPath"
}

$safeSlug = ($Slug.Trim().ToLowerInvariant() -replace '[^a-z0-9_-]+', '-').Trim('-')
if (-not $safeSlug) {
  throw "Invalid mockup slug: $Slug"
}

$outputDir = Join-Path $OutputRoot $safeSlug
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$defaultJobRoot = 'E:\tool\ozon_sjsq\dist\mockup-convert'
$jobPath = Join-Path $defaultJobRoot "current-job.json"
New-Item -ItemType Directory -Force -Path $defaultJobRoot | Out-Null
$resolvedPsdPath = (Resolve-Path -LiteralPath $PsdPath).Path.Replace('\', '/')
$normalizedOutputDir = $outputDir.Replace('\', '/')
$job = @{
  psdPath = $resolvedPsdPath
  outputDir = $normalizedOutputDir
  sceneWidth = $SceneWidth
  sceneHeight = $SceneHeight
  replacementKeyword = ''
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $jobPath -Value $job -Encoding UTF8

$jsxPath = 'E:\tool\ozon_sjsq\scripts\export-one-psd-template-layers.jsx'
$photoshop = New-Object -ComObject Photoshop.Application
$photoshop.Visible = $false
$photoshop.DoJavaScriptFile($jsxPath)

$reportPath = Join-Path $outputDir 'export-report.json'
Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath
