#!/usr/bin/env bash
# ============================================================
# sync-prod-db.sh — 从生产服务器同步数据库到本地
# ============================================================
# 用法：
#   1. 修改下方 CONFIG 区域的变量
#   2. chmod +x scripts/sync-prod-db.sh
#   3. bash scripts/sync-prod-db.sh
#
# 流程：
#   SSH 到生产服务器 → pg_dump 导出 → gzip 压缩
#   → scp 下载到 local/ 目录 → 自动调用 Node.js 还原
# ============================================================
set -euo pipefail

# ── 配置区域（来源: docs/deploy-config.md）────────────────
SERVER_HOST="101.32.167.34"                           # 阿里云服务器 IP
SSH_USER="root"                                        # SSH 用户名
SSH_KEY="$HOME/.ssh/ozon_sjsq_tencent_deploy_ed25519" # SSH 私钥
DB_NAME="ozon_sjsq_cloud"                              # 生产数据库名
DB_USER="ozon_sjsq"                                    # 生产数据库用户
DB_PASSWORD="MQDVV4DNalIKwXaYy1ZZuRXHKiN6eQqB"                    # ⚠️ 请勿提交到版本控制
# ──────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DUMP_DIR="$PROJECT_DIR/local/db-sync"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="$DUMP_DIR/prod_dump_${TIMESTAMP}.sql.gz"

mkdir -p "$DUMP_DIR"

echo "=========================================="
echo "  生产数据库同步工具"
echo "=========================================="
echo "  服务器:   ${SSH_USER}@${SERVER_HOST}"
echo "  数据库:   ${DB_NAME}"
echo "  输出文件: ${DUMP_FILE}"
echo "=========================================="

# 检查 SSH 连通性
echo ""
echo "[1/4] 检查 SSH 连接..."
if ! ssh -i "${SSH_KEY}" -o ConnectTimeout=5 -o BatchMode=yes "${SSH_USER}@${SERVER_HOST}" "echo ok" 2>/dev/null; then
    echo "  [WARN] 免密登录不可用，将尝试交互式登录"
    echo "  提示: 检查 SSH 私钥路径 ${SSH_KEY} 是否存在"
fi

# 在服务器上执行 pg_dump
echo ""
echo "[2/4] 在生产服务器上导出数据库..."
REMOTE_TMP="/tmp/ozon_sjsq_cloud_dump_${TIMESTAMP}.sql.gz"

ssh -i "${SSH_KEY}" "${SSH_USER}@${SERVER_HOST}" "
    export PGPASSWORD='${DB_PASSWORD}'
    pg_dump \\
        -U ${DB_USER} \\
        -h 127.0.0.1 \\
        -d ${DB_NAME} \\
        --no-owner \\
        --no-acl \\
        --clean \\
        --if-exists \\
        -v \\
    | gzip > ${REMOTE_TMP}
    echo 'pg_dump exit code: '\$?
    ls -lh ${REMOTE_TMP}
"

# 下载到本地
echo ""
echo "[3/4] 下载 SQL dump 到本地..."
scp -i "${SSH_KEY}" "${SSH_USER}@${SERVER_HOST}:${REMOTE_TMP}" "$DUMP_FILE"

# 清理服务器临时文件
ssh -i "${SSH_KEY}" "${SSH_USER}@${SERVER_HOST}" "rm -f ${REMOTE_TMP}"

echo ""
echo "[4/4] 清理完成"
echo "  Dump 已保存到: ${DUMP_FILE}"

# 验证文件完整性
ACTUAL_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE" 2>/dev/null || echo "0")
if [ "$ACTUAL_SIZE" -lt 100 ]; then
    echo "  [ERROR] Dump 文件过小 (${ACTUAL_SIZE} bytes)，可能导出失败"
    exit 1
fi

echo "  Dump 文件大小: $(du -h "$DUMP_FILE" | cut -f1)"

# 自动还原到本地
echo ""
echo "=========================================="
echo "  下一步: 运行本地还原"
echo "=========================================="
echo ""
echo "  方式 1 (自动):  cd server && npm run db:restore -- $DUMP_FILE"
echo "  方式 2 (手动):  cd server && node scripts/restore-local-db.js $DUMP_FILE"
echo ""
echo "  注意: 还原前请确保本地 PostgreSQL 已启动"
echo "        (可以用 docker-compose up -d 启动 Docker 版)"
echo ""
