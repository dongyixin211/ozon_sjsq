param(
  [Parameter(Mandatory = $true)]
  [string]$PsdPath,

  [string]$OutputRoot = 'E:\tool\ozon_sjsq\dist\mockup-convert',

  [string]$Slug = 'zhuobu-replace-alpha'
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PsdPath)) {
  throw "PSD file not found: $PsdPath"
}

$outputDir = Join-Path $OutputRoot $Slug
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$jobPath = Join-Path $OutputRoot "current-job.json"
$job = @{
  psdPath = (Resolve-Path -LiteralPath $PsdPath).Path.Replace('\', '/')
  outputDir = $outputDir.Replace('\', '/')
  sceneWidth = 800
  sceneHeight = 1067
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $jobPath -Value $job -Encoding UTF8

$jsxPath = 'E:\tool\ozon_sjsq\scripts\export-zhuobu-replace-alpha.jsx'
$photoshop = New-Object -ComObject Photoshop.Application
$photoshop.Visible = $false
$photoshop.DoJavaScriptFile($jsxPath)

Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $outputDir 'replace-alpha-report.json')
