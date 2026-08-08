# Ozon SaaS V2 首期基础能力 Implementation Plan

**Goal:** 在不下线旧功能的前提下，建立 V2 租户、设备、SKU 和任务协议。

**Architecture:** 新增 PostgreSQL V2 表和 `/api/v2` 路由；旧 API 与页面不改动。云端只协调租户、设备、店铺镜像、SKU 与任务，Ozon 请求仍由 Windows 助手执行。

## Task 1: V2 数据库与租户边界

**Files:** `server/migrations/`、`server/src/db.ts`、`packages/shared/src/types.ts`、对应测试。

1. 先写租户过滤和 SKU 并发预留失败测试。
2. 新增 tenants、tenant_users、devices、shops_v2、products_v2、sku_reservations、tasks_v2、task_items_v2、task_logs_v2 表。
3. 所有业务唯一键以 `tenant_id` 为前缀；`tenant_id + sku` 唯一。
4. 以事务实现预留、显式释放与已提交 SKU 不自动释放。
5. 运行数据库/服务测试验证越权与并发场景。

## Task 2: V2 鉴权、设备配对与令牌

**Files:** `server/src/routes/`、`server/src/auth*`、`server/src/index.ts`、`packages/shared/src/types.ts`、测试。

1. 写配对码一次性使用、设备撤销、跨租户访问拒绝测试。
2. 增加 `/api/v2/devices/pairing-codes`、`/pair`、`/heartbeat`、`/revoke`。
3. 设备使用可撤销令牌；网页用户令牌与设备令牌权限分离。
4. 店铺镜像 API 只接受元数据，拒绝 Ozon 凭证字段。
5. 运行路由集成测试。

## Task 3: V2 任务租约协议

**Files:** `server/src/routes/`、`server/src/services/`、`packages/shared/src/types.ts`、测试。

1. 写创建幂等、原子领取、租约过期、取消与进度回传测试。
2. 实现创建、按设备领取、续租、阶段回传、取消、失败项重试 API。
3. 使用设计稿定义的任务状态；任务查询强制租户过滤。
4. 运行任务服务与路由测试。

## Task 4: Windows 助手 V2 连接骨架

**Files:** `src-tauri/src/core/`、`src-tauri/src/lib.rs`、`src/lib/`、测试。

1. 写设备令牌本地安全存储和撤销后拒绝领取测试。
2. 实现配对、心跳、任务轮询、领取、续租和日志回传客户端。
3. 仅识别 V2 Excel 成品图上架任务，实际 Ozon 上架复用既有 Rust 核心。
4. 重启时先查询任务状态与 Ozon 结果，再决定继续或停止。
5. 运行 Rust 单元测试与针对性集成测试。

## Task 5: V2 网页入口与验收

**Files:** `src/features/`、`src/App.tsx`、`src/lib/`、用户文档、测试。

1. 新增 V2 设备、店铺、SKU、任务中心入口，不替换旧页面。
2. 默认仅展示当前租户数据；设备离线、租约和任务状态可见。
3. 为跨租户隔离、SKU 预留、设备撤销、助手重启恢复写验收测试。
4. 运行服务测试、Rust 测试、前端测试与生产构建。
