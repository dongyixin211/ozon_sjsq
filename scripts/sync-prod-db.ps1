# ============================================================
# sync-prod-db.ps1 — 从生产服务器同步数据库到本地 (PowerShell 版)
# ============================================================
# 运行前请确保已执行 install-local-pg.ps1 安装本地 PostgreSQL
# ============================================================

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DumpDir    = Join-Path $ProjectDir "local\db-sync"
$Timestamp  = Get-Date -Format "yyyyMMdd_HHmmss"
$DumpFile   = Join-Path $DumpDir "prod_dump_${Timestamp}.sql.gz"

# ── 服务器配置 ──
$ServerHost = "101.32.167.34"
$SshUser    = "root"
$SshKey     = "$env:USERPROFILE\.ssh\ozon_sjsq_tencent_deploy_ed25519"
$RemoteTmp  = "/tmp/ozon_sjsq_cloud_dump_${Timestamp}.sql.gz"

# 确保 dump 目录存在
if (-not (Test-Path $DumpDir)) { New-Item -ItemType Directory $DumpDir -Force | Out-Null }

Write-Host "============================================"  -ForegroundColor Cyan
Write-Host "  生产数据库同步工具 (PowerShell)" -ForegroundColor Cyan
Write-Host "============================================"  -ForegroundColor Cyan
Write-Host "  服务器:   ${SshUser}@${ServerHost}" -ForegroundColor White
Write-Host "  输出文件: ${DumpFile}" -ForegroundColor White
Write-Host "============================================"  -ForegroundColor Cyan
Write-Host ""

# ── Step 1: 检查 SSH 密钥 ──
if (-not (Test-Path $SshKey)) {
    Write-Host "[ERROR] SSH 私钥不存在: $SshKey" -ForegroundColor Red
    Write-Host "  请确保 docs/deploy-config.md 中的密钥路径正确" -ForegroundColor Yellow
    exit 1
}

# ── Step 2: 在服务器上导出 ──
Write-Host "[1/3] 在生产服务器上导出数据库..." -ForegroundColor Yellow

$dumpCmd = @"
export PGPASSWORD='MQDVV4DNalIKwXaYy1ZZuRXHKiN6eQqB'
pg_dump \
    -U ozon_sjsq \
    -h 127.0.0.1 \
    -d ozon_sjsq_cloud \
    --no-owner \
    --no-acl \
    --clean \
    --if-exists \
    -v \
| gzip > ${RemoteTmp}
echo "EXIT_CODE: \`$?"
ls -lh ${RemoteTmp}
"@

$dumpResult = ssh -i $SshKey -o StrictHostKeyChecking=no "${SshUser}@${ServerHost}" $dumpCmd 2>&1
Write-Host $dumpResult
Write-Host "  [OK] 导出完成" -ForegroundColor Green

# ── Step 3: 下载到本地 ──
Write-Host ""
Write-Host "[2/3] 下载 SQL dump 到本地..." -ForegroundColor Yellow

scp -i $SshKey -o StrictHostKeyChecking=no "${SshUser}@${ServerHost}:${RemoteTmp}" $DumpFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] 下载失败" -ForegroundColor Red
    exit 1
}

# 清理服务器临时文件
ssh -i $SshKey -o StrictHostKeyChecking=no "${SshUser}@${ServerHost}" "rm -f ${RemoteTmp}"

$fileSize = (Get-Item $DumpFile).Length
if ($fileSize -lt 100) {
    Write-Host "  [ERROR] Dump 文件过小 ($fileSize bytes)，可能导出失败" -ForegroundColor Red
    exit 1
}

Write-Host "  [OK] 下载完成 ($([math]::Round($fileSize/1MB, 1)) MB)" -ForegroundColor Green

# ── Step 4: 还原到本地 PostgreSQL ──
Write-Host ""
Write-Host "[3/3] 还原到本地 PostgreSQL..." -ForegroundColor Yellow
Write-Host ""

$ServerDir = Join-Path $ProjectDir "server"
$RestoreScript = Join-Path $ProjectDir "scripts\restore-local-db.js"

# 调用 Node.js 还原脚本
Push-Location $ServerDir
try {
    node $RestoreScript $DumpFile
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [WARN] 还原过程可能有非关键错误，请检查输出" -ForegroundColor Yellow
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "============================================"  -ForegroundColor Green
Write-Host "  同步完成!" -ForegroundColor Green
Write-Host "============================================"  -ForegroundColor Green
Write-Host ""
Write-Host "  Dump 文件: $DumpFile" -ForegroundColor White
Write-Host "  启动开发:  cd server && npm run dev" -ForegroundColor Yellow
Write-Host ""
