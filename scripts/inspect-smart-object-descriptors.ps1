param(
  [Parameter(Mandatory = $true)]
  [string]$PsdPath,

  [string]$Slug = "",

  [string]$OutputRoot = "E:\tool\ozon_sjsq\dist\mockup-inspect-smart"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PsdPath)) {
  throw "PSD 文件不存在：$PsdPath"
}

if (-not $Slug) {
  $Slug = [System.IO.Path]::GetFileNameWithoutExtension($PsdPath)
}

$safeSlug = ($Slug -replace '[\\/:*?"<>|\s()]+', '-').Trim('-')
if (-not $safeSlug) {
  throw "无法生成样机标识：$Slug"
}

$outputDir = Join-Path $OutputRoot $safeSlug
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$jobPath = Join-Path $OutputRoot "current-job.json"
$job = @{
  psdPath = (Resolve-Path -LiteralPath $PsdPath).Path.Replace("\", "/")
  outputDir = $outputDir.Replace("\", "/")
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $jobPath -Value $job -Encoding UTF8

$jsxPath = "E:\tool\ozon_sjsq\scripts\inspect-smart-object-descriptors.jsx"
$photoshop = New-Object -ComObject Photoshop.Application
$photoshop.Visible = $false
$photoshop.DoJavaScriptFile($jsxPath)

Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $outputDir "smart-report.json")
