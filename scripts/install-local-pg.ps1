# ============================================================
# install-local-pg.ps1 — 一键安装 PostgreSQL 并同步生产数据到本地
# ============================================================
# 用法:
#   右键 -> 使用 PowerShell 运行
#   或在 PowerShell 中执行:
#     Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#     .\scripts\install-local-pg.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ToolsDir   = Join-Path $ProjectDir "local"
$PgDir      = Join-Path $ToolsDir "pgsql16"
$PgBin      = Join-Path $PgDir "pgsql\bin"
$PgData     = Join-Path $ToolsDir "pgsql16-data"
$PgPort     = 5433  # 使用 5433 避免和已有 PostgreSQL 冲突

$PgUser = "ozon_sjsq"
$PgPass = "MQDVV4DNalIKwXaYy1ZZuRXHKiN6eQqB"  # 与生产密码一致
$PgDb   = "ozon_sjsq_cloud"

Write-Host "============================================"  -ForegroundColor Cyan
Write-Host "  Ozon SJSQ - 本地 PostgreSQL 安装与数据同步" -ForegroundColor Cyan
Write-Host "============================================"  -ForegroundColor Cyan
Write-Host ""

# ── Step 1: 下载 PostgreSQL 16 ──
$PgZip = Join-Path $ToolsDir "postgresql-16.zip"
if (-not (Test-Path $PgZip)) {
    Write-Host "[1/5] 下载 PostgreSQL 16 (约 294MB)..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://get.enterprisedb.com/postgresql/postgresql-16.8-1-windows-x64-binaries.zip" -OutFile $PgZip
    Write-Host "  [OK] 下载完成" -ForegroundColor Green
} else {
    Write-Host "[1/5] PostgreSQL 已下载，跳过" -ForegroundColor Gray
}

# ── Step 2: 解压 ──
if (-not (Test-Path (Join-Path $PgBin "pg_ctl.exe"))) {
    Write-Host "[2/5] 解压 PostgreSQL..." -ForegroundColor Yellow
    if (Test-Path $PgDir) { Remove-Item $PgDir -Recurse -Force }
    Expand-Archive -Path $PgZip -DestinationPath $PgDir -Force
    Write-Host "  [OK] 解压完成" -ForegroundColor Green
} else {
    Write-Host "[2/5] PostgreSQL 已解压，跳过" -ForegroundColor Gray
}

# ── Step 3: 初始化数据库集群 ──
if (-not (Test-Path (Join-Path $PgData "PG_VERSION"))) {
    Write-Host "[3/5] 初始化数据库集群..." -ForegroundColor Yellow

    # 确保数据目录存在
    if (-not (Test-Path $PgData)) { New-Item -ItemType Directory $PgData -Force | Out-Null }

    & (Join-Path $PgBin "initdb.exe") `
        -D $PgData `
        -U postgres `
        --auth=trust `
        --encoding=UTF8 `
        --locale=C `
        --no-instructions `
        2>&1 | ForEach-Object { Write-Host "  $_" }

    if ($LASTEXITCODE -ne 0) {
        throw "initdb 失败"
    }

    # 修改配置：端口 + 监听地址
    $PgConf = Join-Path $PgData "postgresql.conf"
    $content = Get-Content $PgConf -Raw
    $content = $content -replace "#port = 5432", "port = $PgPort"
    $content = $content -replace "#listen_addresses = 'localhost'", "listen_addresses = '127.0.0.1'"
    $content = $content -replace "port = 5432", "port = $PgPort"
    Set-Content $PgConf $content -NoNewline

    Write-Host "  [OK] 初始化完成 (端口: $PgPort)" -ForegroundColor Green
} else {
    Write-Host "[3/5] 数据库集群已存在，跳过初始化" -ForegroundColor Gray
}

# ── Step 4: 启动 PostgreSQL ──
Write-Host "[4/5] 启动 PostgreSQL..." -ForegroundColor Yellow

# 先检查是否已经在运行
$pgRunning = $false
try {
    & (Join-Path $PgBin "pg_isready.exe") -h 127.0.0.1 -p $PgPort -q 2>$null
    if ($LASTEXITCODE -eq 0) { $pgRunning = $true }
} catch { }

if (-not $pgRunning) {
    & (Join-Path $PgBin "pg_ctl.exe") start -D $PgData -l (Join-Path $PgData "pg.log") -w 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [WARN] 启动可能失败，尝试检查日志: $PgData\pg.log" -ForegroundColor Yellow
    } else {
        Write-Host "  [OK] PostgreSQL 已启动 (端口: $PgPort)" -ForegroundColor Green
    }
} else {
    Write-Host "  [OK] PostgreSQL 已在运行" -ForegroundColor Green
}

# ── Step 5: 创建数据库用户和数据库（使用生产密码） ──
Write-Host "[5/5] 配置数据库..." -ForegroundColor Yellow

$psql = Join-Path $PgBin "psql.exe"
$psqlArgs = @("-h", "127.0.0.1", "-p", $PgPort, "-U", "postgres", "-d", "postgres", "-c")

# 检查用户是否存在
$userExists = & $psql -h 127.0.0.1 -p $PgPort -U postgres -d postgres -t -c "SELECT 1 FROM pg_roles WHERE rolname='$PgUser';" 2>$null
if (-not ($userExists -match "1")) {
    Write-Host "  创建用户 $PgUser ..."
    & $psql @psqlArgs "CREATE USER $PgUser WITH PASSWORD '$PgPass' CREATEDB;"
    Write-Host "  [OK] 用户已创建" -ForegroundColor Green
} else {
    Write-Host "  用户 $PgUser 已存在" -ForegroundColor Gray
    # 更新密码为生产密码
    & $psql @psqlArgs "ALTER USER $PgUser WITH PASSWORD '$PgPass';"
}

# 检查数据库是否存在
$dbExists = & $psql -h 127.0.0.1 -p $PgPort -U postgres -d postgres -t -c "SELECT 1 FROM pg_database WHERE datname='$PgDb';" 2>$null
if (-not ($dbExists -match "1")) {
    Write-Host "  创建数据库 $PgDb ..."
    & $psql @psqlArgs "CREATE DATABASE $PgDb OWNER $PgUser;"
    Write-Host "  [OK] 数据库已创建" -ForegroundColor Green
} else {
    Write-Host "  数据库 $PgDb 已存在" -ForegroundColor Gray
}

# ── Step 6: 同步生产数据 ──
Write-Host ""
Write-Host "============================================"  -ForegroundColor Cyan
Write-Host "  下一步: 同步生产数据" -ForegroundColor Cyan
Write-Host "============================================"  -ForegroundColor Cyan
Write-Host ""

$SyncScript = Join-Path $ProjectDir "scripts\sync-prod-db.ps1"
if (Test-Path $SyncScript) {
    Write-Host "  运行同步脚本 (将从服务器下载生产数据并还原到本地):" -ForegroundColor Yellow
    Write-Host "    & `"$SyncScript`"" -ForegroundColor White
} else {
    Write-Host "  手动同步:" -ForegroundColor Yellow
    Write-Host "    1. 编辑 scripts/sync-prod-db.sh，确保 DB_PASSWORD 已填写" -ForegroundColor White
    Write-Host "    2. Git Bash 运行: bash scripts/sync-prod-db.sh" -ForegroundColor White
    Write-Host "    3. 还原数据: cd server && npm run db:restore" -ForegroundColor White
}

# ── 本地 .env 配置 ──
Write-Host ""
Write-Host "============================================"  -ForegroundColor Cyan
Write-Host "  本地 .env 配置" -ForegroundColor Cyan
Write-Host "============================================"  -ForegroundColor Cyan
Write-Host ""

$LocalEnv = Join-Path $ProjectDir "server\.env"
$LocalEnvContent = @"
NODE_ENV=development
PORT=8787
PUBLIC_API_BASE_URL=http://127.0.0.1:8787
JWT_SECRET=local-dev-jwt-secret-change-me-24chars
ADMIN_TOKEN=local-dev-admin-token
SUPER_ADMIN_PHONE=18338062216
DATABASE_URL=postgresql://${PgUser}:${PgPass}@127.0.0.1:${PgPort}/${PgDb}
STORAGE_PROVIDER=local
STORAGE_LOCAL_DIR=./uploads
MAX_UPLOAD_MB=15
"@

# 备份现有 .env
if (Test-Path $LocalEnv) {
    $backup = "$LocalEnv.backup.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    Copy-Item $LocalEnv $backup
    Write-Host "  已备份现有 .env -> $backup" -ForegroundColor Gray
}

Set-Content $LocalEnv $LocalEnvContent -NoNewline
Write-Host "  [OK] 已写入 server/.env (使用本地 PostgreSQL :$PgPort)" -ForegroundColor Green

# ── 完成 ──
Write-Host ""
Write-Host "============================================"  -ForegroundColor Green
Write-Host "  安装完成!" -ForegroundColor Green
Write-Host "============================================"  -ForegroundColor Green
Write-Host ""
Write-Host "  PostgreSQL:  $PgDir" -ForegroundColor White
Write-Host "  数据目录:    $PgData" -ForegroundColor White
Write-Host "  端口:        $PgPort" -ForegroundColor White
Write-Host "  用户/密码:   $PgUser / (生产密码)" -ForegroundColor White
Write-Host "  数据库:      $PgDb" -ForegroundColor White
Write-Host "  连接串:      postgresql://${PgUser}:${PgPass}@127.0.0.1:${PgPort}/${PgDb}" -ForegroundColor White
Write-Host ""
Write-Host "  启动 PostgreSQL:  & `"$PgBin\pg_ctl.exe`" start -D $PgData -l `"$PgData\pg.log`"" -ForegroundColor Yellow
Write-Host "  停止 PostgreSQL:  & `"$PgBin\pg_ctl.exe`" stop -D $PgData" -ForegroundColor Yellow
Write-Host "  连接数据库:       & `"$PgBin\psql.exe`" -h 127.0.0.1 -p $PgPort -U $PgUser -d $PgDb" -ForegroundColor Yellow
Write-Host ""
Write-Host "  启动开发服务:     cd server && npm run dev" -ForegroundColor Yellow
Write-Host ""

Read-Host "按 Enter 退出"
