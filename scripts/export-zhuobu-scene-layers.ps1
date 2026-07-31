param(
  [Parameter(Mandatory = $true)]
  [string]$PsdPath,

  [int]$Scene = 1,

  [string]$OutputRoot = 'E:\tool\ozon_sjsq\dist\mockup-scene-diagnose\zhuobu'
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PsdPath)) {
  throw "PSD file not found: $PsdPath"
}

$defaultJobRoot = 'E:\tool\ozon_sjsq\dist\mockup-convert'
New-Item -ItemType Directory -Force -Path $defaultJobRoot | Out-Null

$outputDir = Join-Path $OutputRoot ("scene-{0:D2}" -f $Scene)
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$jobPath = Join-Path $defaultJobRoot 'current-job.json'
$job = @{
  psdPath = (Resolve-Path -LiteralPath $PsdPath).Path.Replace('\', '/')
  outputDir = $outputDir.Replace('\', '/')
  sceneWidth = 800
  sceneHeight = 1067
  targetScene = $Scene
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $jobPath -Value $job -Encoding UTF8

$photoshop = New-Object -ComObject Photoshop.Application
$photoshop.Visible = $false
$photoshop.DoJavaScriptFile('E:\tool\ozon_sjsq\scripts\export-zhuobu-scene-layers.jsx')

$reportPath = Join-Path $outputDir 'scene-export-report.json'
Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath
