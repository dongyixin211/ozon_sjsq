param(
  [Parameter(Mandatory = $true)]
  [string]$PsdPath,

  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [string]$Sku = "",

  [string]$OutputFormat = "gif",

  [string]$SourceFit = "fill",

  [int]$SceneWidth = 800,

  [int]$SceneHeight = 1067,

  [int]$SceneCount = 9,

  [int]$SourceWidth = 1600,

  [int]$SourceHeight = 960
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PsdPath)) {
  throw "PSD file not found: $PsdPath"
}

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "Source image not found: $SourcePath"
}

if (-not $Sku) {
  $Sku = [System.IO.Path]::GetFileNameWithoutExtension($SourcePath)
}

if ($OutputFormat -notin @("gif", "png", "jpg", "jpeg")) {
  throw "Unsupported output format: $OutputFormat"
}

if ($SourceFit -notin @("fill", "cover", "none")) {
  throw "Unsupported SourceFit: $SourceFit"
}

$jobRoot = "E:\tool\ozon_sjsq\dist\ps-render\zhuobu"
$jobDir = New-Item -ItemType Directory -Force -Path $jobRoot
$resolvedOutputDir = New-Item -ItemType Directory -Force -Path $OutputDir

$jobPath = Join-Path $jobDir.FullName "current-job.json"
$preparedSourcePath = Join-Path $jobDir.FullName ("prepared-{0}.png" -f ([guid]::NewGuid().ToString("N")))

$job = @{
  psdPath = (Resolve-Path -LiteralPath $PsdPath).Path.Replace("\", "/")
  sourcePath = (Resolve-Path -LiteralPath $SourcePath).Path.Replace("\", "/")
  preparedSourcePath = $preparedSourcePath.Replace("\", "/")
  outputDir = $resolvedOutputDir.FullName.Replace("\", "/")
  sku = $Sku
  outputFormat = $OutputFormat.ToLowerInvariant()
  sourceFit = $SourceFit
  sceneWidth = $SceneWidth
  sceneHeight = $SceneHeight
  sceneCount = $SceneCount
  sourceWidth = $SourceWidth
  sourceHeight = $SourceHeight
} | ConvertTo-Json -Depth 6
Set-Content -LiteralPath $jobPath -Value $job -Encoding UTF8

$photoshop = New-Object -ComObject Photoshop.Application
$photoshop.Visible = $false
$photoshop.DoJavaScriptFile("E:\tool\ozon_sjsq\scripts\render-zhuobu-ps-mockup.jsx")

$reportPath = Join-Path $resolvedOutputDir.FullName "ps-render-report.json"
Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath
