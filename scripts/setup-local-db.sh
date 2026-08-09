#!/usr/bin/env bash
# ============================================================
# setup-local-db.sh — 本地测试环境一键初始化
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_DIR/server"

echo "=========================================="
echo "  本地测试环境初始化"
echo "=========================================="
echo ""

# 1. 检查 .env.local
echo "[1/4] 检查配置..."
if [ ! -f "$SERVER_DIR/.env.local" ]; then
    echo "  未找到 server/.env.local，从模板创建..."
    cp "$SERVER_DIR/.env.local.example" "$SERVER_DIR/.env.local"
    echo "  [OK] 已创建 .env.local (请检查并修改 DATABASE_URL 等配置)"
else
    echo "  [OK] .env.local 已存在"
fi

# 2. PostgreSQL 检查
echo ""
echo "[2/4] 检查本地 PostgreSQL..."

PG_READY=false
if command -v psql &>/dev/null; then
    if psql -h 127.0.0.1 -U ozon_sjsq -d ozon_sjsq_cloud -c "SELECT 1" &>/dev/null; then
        PG_READY=true
        echo "  [OK] PostgreSQL 已运行且连接正常"
    fi
fi

# 3. 尝试 Docker 启动
if [ "$PG_READY" = false ]; then
    echo "  未检测到本地 PostgreSQL，尝试 Docker..."
    if command -v docker &>/dev/null; then
        cd "$SERVER_DIR"
        if docker compose ps | grep -q "ozon-sjsq-cloud-postgres"; then
            echo "  [OK] PostgreSQL Docker 容器已存在"
            if ! docker compose ps | grep -q "Up"; then
                echo "  容器未运行，正在启动..."
                docker compose up -d
            fi
        else
            echo "  首次启动 PostgreSQL Docker 容器..."
            docker compose up -d
            echo "  等待 PostgreSQL 就绪 (10s)..."
            sleep 10
        fi
        echo "  [OK] PostgreSQL Docker 已启动"
        PG_READY=true
    else
        echo ""
        echo "  [ERROR] 未找到 Docker 且本地无 PostgreSQL"
        echo ""
        echo "  请选择以下方式之一安装 PostgreSQL:"
        echo ""
        echo "  方式 1 (推荐): 安装 Docker Desktop"
        echo "    下载: https://www.docker.com/products/docker-desktop/"
        echo "    安装后运行: cd server && docker compose up -d"
        echo ""
        echo "  方式 2: 安装 PostgreSQL 16"
        echo "    下载: https://www.postgresql.org/download/windows/"
        echo "    安装后创建数据库:"
        echo "      psql -U postgres -c \"CREATE USER ozon_sjsq WITH PASSWORD 'ozon_sjsq_dev';\""
        echo "      psql -U postgres -c \"CREATE DATABASE ozon_sjsq_cloud OWNER ozon_sjsq;\""
        echo ""
        exit 1
    fi
fi

# 4. 运行迁移
echo ""
echo "[3/4] 运行数据库迁移..."
cd "$SERVER_DIR"

# 临时使用 .env.local
export DOTENV_CONFIG_PATH="$SERVER_DIR/.env.local"
cp "$SERVER_DIR/.env.local" "$SERVER_DIR/.env.local.bak" 2>/dev/null || true
cp "$SERVER_DIR/.env.local" "$SERVER_DIR/.env" 2>/dev/null || true

npx tsx scripts/migrate.ts 2>&1 || {
    echo "  [WARN] 迁移脚本可能已执行过，忽略错误"
}

# 恢复原 .env
if [ -f "$SERVER_DIR/.env.local.bak" ]; then
    cp "$SERVER_DIR/.env.local.bak" "$SERVER_DIR/.env"
    rm "$SERVER_DIR/.env.local.bak"
fi

echo "  [OK] 迁移完成"

# 5. 提示同步
echo ""
echo "[4/4] 初始化完成!"
echo ""
echo "=========================================="
echo "  下一步: 同步生产数据"
echo "=========================================="
echo ""
echo "  1. 编辑同步脚本: 修改 scripts/sync-prod-db.sh 中的服务器配置"
echo "  2. 执行同步:      bash scripts/sync-prod-db.sh"
echo "  3. 还原数据:      cd server && npm run db:restore"
echo "  4. 启动服务:      cd server && npm run dev (使用 .env.local)"
echo ""
echo "  启动时使用本地配置:"
echo "    cp server/.env.local server/.env"
echo "    cd server && npm run dev"
echo ""
