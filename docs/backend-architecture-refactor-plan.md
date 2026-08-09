# Ozon SJSQ 后端架构重构方案

> **版本**: 1.2
> **日期**: 2026-08-08
> **范围**: server/ 后端工程
> **目标**: 从扁平单文件结构重构为分层模块化架构，提升扩展性、稳定性、可测试性和团队协作效率
> **v1.1 更新**: 新增第九章 RBAC 角色权限控制（角色扩展 + 功能标识 + 菜单过滤）
> **v1.2 更新**: 新增第 9.9 节 前端管理页面设计（用户管理 + 功能开关 + 操作日志）

---

## 一、现状分析

### 1.1 技术栈

| 组件 | 技术选型 | 版本 |
|------|----------|------|
| Web 框架 | Fastify | 4.28.1 |
| 数据库 | PostgreSQL | 16 |
| 数据库驱动 | node-pg | 8.12 |
| 缓存/限流 | Redis (ioredis) | 5.11 (可选) |
| 对象存储 | Cloudflare R2 (AWS SDK) | 3.614 |
| 认证 | JWT (jsonwebtoken) + bcrypt | 9.0 / 2.4 |
| 图片处理 | Sharp | 0.33 |
| 验证 | Zod | 3.23 |
| 桌面客户端 | Tauri (Rust + React) | 2.0 |
| Web 客户端 | React + Vite | 18 / 5.4 |
| 部署 | Nginx 反代 + systemd 单进程 | - |

### 1.2 当前代码规模

| 文件 | 行数 | 职责 |
|------|------|------|
| gallery-routes.ts | **5,712** | 图库上传/列表/去重/缩略图/标题生成/上架流程/样机渲染 |
| mockup-renderer.ts | 1,903 | 样机图层合成 |
| admin-routes.ts | 1,147 | 管理后台全部接口 |
| mockup-template-service.ts | 720 | 样机模板管理 |
| gallery-auto-listing-routes.ts | 516 | 自动上架子路由 |
| index.ts | 420 | 入口(含 @ts-nocheck) |
| storage.ts | 394 | R2/本地存储适配 |
| 其他文件 | ~3,900 | auth/config/db/errors/rate-limit 等 |
| **合计** | **~14,728** | - |

### 1.3 六大核心问题

#### 问题 1: 扁平文件结构
全部 `.ts` 文件散落在 `server/src/` 根目录，没有任何模块边界或目录分层。新增功能时开发者无法判断代码应该放在哪里，导致文件越加越多、越来越乱。

#### 问题 2: 巨型路由文件
`gallery-routes.ts` 达 **5,712 行**，将图库管理、图片上传、去重、缩略图生成、AI 标题生成、自动上架流程、样机渲染等完全不同的业务领域堆在一个文件里。多人同时修改必然产生合并冲突。

#### 问题 3: 类型安全缺失
`index.ts`（入口文件）和 `gallery-routes.ts` 顶部都标记了 `@ts-nocheck`，关闭了 TypeScript 类型检查。这意味着入口和最大文件完全没有类型保护，运行时错误只能靠线上暴露。

#### 问题 4: 无服务层 / 仓储层
路由处理函数中直接混合了：
- 请求验证 (Zod schema)
- 业务逻辑判断
- SQL 查询 (pool.query)
- 对象存储操作 (S3 upload)
- 图片处理 (Sharp)
- 并发控制 (进程内 Map/Set)

没有任何分层，业务逻辑无法独立测试，SQL 散落在各处难以优化。

#### 问题 5: 无任务队列
标题生成、批量上传等异步任务使用进程内的 `Map`、`Set` 和全局变量管理并发：
```typescript
// gallery-routes.ts 中的进程内状态
const activeUploadTasks = new Set();
const uploadTaskQueue = [];
let activeTitleGenerationCount = 0;
const activeTitleGenerationByUser = new Map();
const titleGenerationQueue = [];
```
这些状态**进程重启即丢失**，正在进行的任务无法恢复，也无法水平扩展到多实例。

#### 问题 6: 单进程部署
当前部署方案是单个 Node.js 进程 + systemd 管理，没有：
- 水平扩展能力
- 优雅关闭（Drain 在途请求）
- 健康检查深度探针
- 熔断器保护外部调用
- 结构化日志聚合

---

## 二、目标架构设计

### 2.1 设计原则

| 原则 | 说明 |
|------|------|
| **分层隔离** | 路由 → 控制器 → 服务 → 仓储，每层只做自己的事 |
| **模块自治** | 每个领域模块有独立目录，对外只暴露 service 接口 |
| **依赖单向** | 外层依赖内层，内层不知道外层（依赖倒置） |
| **渐进迁移** | 新旧代码并行运行，逐模块迁移，不中断线上服务 |
| **微服务预备** | 模块边界清晰后可按需拆分，不需要重写业务代码 |

### 2.2 目标目录结构

```
server/src/
├── core/                        # 横切关注点（所有模块共享）
│   ├── config.ts                # 环境变量解析 (Zod 验证)
│   ├── database/
│   │   ├── pool.ts              # PG 连接池
│   │   ├── transaction.ts       # 事务封装 (withClient / withTransaction)
│   │   └── metrics.ts           # 查询性能追踪 (AsyncLocalStorage)
│   ├── errors/
│   │   ├── AppError.ts          # 应用错误基类
│   │   ├── handler.ts           # 全局错误处理中间件
│   │   └── codes.ts             # 错误码枚举
│   ├── logging/
│   │   ├── logger.ts            # Pino 结构化日志
│   │   └── request-tracer.ts    # 请求关联 ID
│   ├── auth/
│   │   ├── middleware.ts        # requireAuth / requireMembership / requireAdmin
│   │   ├── token.ts             # JWT 签发/验证
│   │   └── types.ts             # CurrentUser 类型
│   ├── rate-limit/
│   │   └── middleware.ts       # 限流（Redis / 内存双模式）
│   ├── health/
│   │   └── probe.ts             # 深度健康检查（DB + Redis + R2）
│   └── shutdown/
│       └── graceful.ts          # 优雅关闭（Drain 请求 + 关连接池）
│
├── modules/                     # 领域模块（每个模块独立自治）
│   ├── auth/                    # 认证授权
│   │   ├── routes.ts
│   │   ├── controllers/
│   │   │   └── auth.controller.ts
│   │   ├── services/
│   │   │   └── auth.service.ts
│   │   ├── repositories/
│   │   │   ├── user.repository.ts
│   │   │   ├── device.repository.ts
│   │   │   └── session.repository.ts
│   │   ├── schemas/
│   │   │   └── auth.schema.ts
│   │   ├── events/
│   │   │   └── auth.events.ts   # UserRegistered / SessionExpired
│   │   └── index.ts             # 公开接口 (只导出 service + types)
│   │
│   ├── gallery/                 # 图库管理
│   │   ├── routes.ts
│   │   ├── controllers/
│   │   │   ├── upload.controller.ts
│   │   │   ├── list.controller.ts
│   │   │   └── featured.controller.ts
│   │   ├── services/
│   │   │   ├── upload.service.ts       # 上传编排
│   │   │   ├── image-prepare.service.ts # 图片预处理
│   │   │   ├── dedup.service.ts        # 去重
│   │   │   └── thumbnail.service.ts    # 缩略图
│   │   ├── repositories/
│   │   │   ├── gallery-asset.repository.ts
│   │   │   └── gallery-query.repository.ts
│   │   ├── schemas/
│   │   │   ├── upload.schema.ts
│   │   │   └── list-query.schema.ts
│   │   ├── events/
│   │   │   └── gallery.events.ts       # GalleryImageUploaded
│   │   └── index.ts
│   │
│   ├── mockup/                  # 样机渲染
│   │   ├── routes.ts
│   │   ├── controllers/
│   │   ├── services/
│   │   │   ├── render.service.ts        # 图层合成
│   │   │   └── template.service.ts     # 模板管理
│   │   ├── repositories/
│   │   │   └── template.repository.ts
│   │   └── index.ts
│   │
│   ├── listing/                 # 自动上架
│   │   ├── routes.ts
│   │   ├── controllers/
│   │   ├── services/
│   │   │   ├── planner.service.ts       # 上架规划
│   │   │   ├── reservation.service.ts   # 选位预约
│   │   │   └── quota.service.ts        # 配额管理
│   │   ├── repositories/
│   │   │   ├── plan.repository.ts
│   │   │   └── snapshot.repository.ts
│   │   └── index.ts
│   │
│   ├── shop/                    # 店铺管理
│   ├── order/                   # 订单/容量
│   ├── product-catalog/         # 商品目录
│   ├── ai/                      # AI 标题生成
│   ├── task/                    # 任务历史
│   └── admin/                   # 管理后台
│
├── infrastructure/              # 基础设施适配层
│   ├── storage/
│   │   ├── adapter.ts           # 统一存储接口
│   │   ├── r2-adapter.ts        # Cloudflare R2 实现
│   │   ├── local-adapter.ts    # 本地文件系统实现
│   │   └── presign.ts          # 预签名 URL
│   ├── cache/
│   │   └── redis-client.ts     # Redis 连接管理
│   ├── queue/
│   │   ├── connection.ts        # BullMQ 连接
│   │   ├── producers/           # 任务生产者
│   │   │   ├── title-generation.producer.ts
│   │   │   ├── batch-upload.producer.ts
│   │   │   └── cleanup.producer.ts
│   │   └── workers/            # 任务消费者
│   │       ├── title-generation.worker.ts
│   │       ├── batch-upload.worker.ts
│   │       └── cleanup.worker.ts
│   └── http/
│       ├── client.ts            # 带超时/重试的 HTTP 客户端
│       └── circuit-breaker.ts  # 熔断器
│
├── app.ts                       # 应用组装根 (注册插件/路由/中间件)
└── server.ts                    # 启动入口 (listen + 优雅关闭)
```

### 2.3 模块内部分层规则

每个领域模块严格遵循四层结构：

```
routes.ts → controllers/ → services/ → repositories/
```

| 层 | 职责 | 禁止 |
|----|------|------|
| **routes.ts** | 路由定义、Zod schema 绑定、preHandler 链挂载 | 业务逻辑、SQL、存储操作 |
| **controllers/** | HTTP 适配：解析请求参数 → 调 service → 格式化响应 | SQL、存储操作、跨模块直接调用 |
| **services/** | 核心业务逻辑：编排、判断、事务管理 | HTTP 相关代码 (request/reply) |
| **repositories/** | 数据访问：SQL 查询、Kysely 类型安全操作 | 业务逻辑、HTTP 适配 |

**依赖规则**: 外层可以依赖内层，内层不能依赖外层。`routes` 依赖 `controllers`，`controllers` 依赖 `services`，`services` 依赖 `repositories`。反向依赖被禁止。

### 2.4 模块间通信

模块之间**不直接 import** 对方的 controller 或 repository，只通过对方 `index.ts` 导出的 service 接口通信：

```typescript
// modules/listing/services/planner.service.ts
import { galleryService } from "../../gallery/index.js";

// 只使用 gallery 模块公开的 service 方法
const images = await galleryService.findAvailableAssets({ shopId, limit: 10 });
```

这样模块边界清晰，未来拆分微服务时只需要将 service 调用替换为 HTTP/RPC 调用。

---

## 三、关键技术改进

### 3.1 数据访问层: 引入 Kysely

**现状**: 使用 `pg.Pool` 直接 `pool.query(sql, params)`，SQL 字符串散落在路由处理函数中，无类型安全。

**改进**: 引入 [Kysely](https://github.com/kysely-org/kysely) — 一个纯 TypeScript SQL 查询构建器，不引入 ORM 的抽象泄漏：

```typescript
// repositories/gallery-asset.repository.ts
import { db } from "../../core/database/kysely.js";

export async function findBySha256(sha256: string) {
  return db.selectFrom("gallery_assets")
    .where("sha256", "=", sha256)
    .selectAll()
    .executeTakeFirst();
}

export async function createAsset(input: CreateAssetInput) {
  return db.insertInto("gallery_assets")
    .values(input)
    .returningAll()
    .executeTakeFirstOrThrow();
}
```

**优势**:
- 编译期类型检查 — 拼错字段名直接报错
- 自动参数绑定 — 不用手动 `$1, $2`
- 查询可组合 — 复用条件片段
- 不引入 ORM 黑盒 — 生成的 SQL 完全可控

### 3.2 任务队列: BullMQ + Redis

**现状**: 标题生成和批量上传使用进程内 `Map/Set` 管理并发，重启即丢失。

**改进**: 引入 [BullMQ](https://docs.bullmq.io/) — 基于 Redis 的持久化任务队列：

```typescript
// infrastructure/queue/producers/title-generation.producer.ts
import { titleGenerationQueue } from "../connection.js";

export async function enqueueTitleGeneration(params: {
  userId: string;
  assetIds: string[];
}) {
  return titleGenerationQueue.add("generate", params, {
    jobId: params.assetIds.join("-"),
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}
```

```typescript
// infrastructure/queue/workers/title-generation.worker.ts
import { Worker } from "bullmq";
import { titleGenerationQueue } from "../connection.js";
import { aiTitleService } from "../../../modules/ai/index.js";

new Worker(titleGenerationQueue, async (job) => {
  const { userId, assetIds } = job.data;
  await aiTitleService.generateTitles({ userId, assetIds });
}, {
  concurrency: config.TITLE_GENERATION_GLOBAL_CONCURRENCY,
});
```

**覆盖场景**:

| 任务类型 | 当前方式 | 改进后 |
|----------|----------|--------|
| AI 标题生成 | `activeTitleGenerationCount` 全局变量 | BullMQ 队列 + Worker |
| 批量上传 | `activeUploadTasks` Set + `uploadTaskQueue` | BullMQ 队列 + Worker |
| 定时清理 | systemd timer + 脚本 | BullMQ Repeat Job |
| 上架流程 | 进程内编排 | BullMQ Flow (多步骤依赖) |

### 3.3 熔断器: 保护外部服务调用

**现状**: AI 模型 API 和 R2 存储调用无熔断保护，外部服务故障会拖垮整个进程。

**改进**: 为所有外部服务调用添加熔断器：

```typescript
// infrastructure/http/circuit-breaker.ts
export class CircuitBreaker {
  private failures = 0;
  private lastFailureAt = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeoutMs: number = 30_000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureAt > this.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        throw new AppError(503, "CIRCUIT_OPEN", "外部服务暂时不可用，请稍后重试");
      }
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = "closed";
      return result;
    } catch (error) {
      this.failures += 1;
      this.lastFailureAt = Date.now();
      if (this.failures >= this.threshold) {
        this.state = "open";
      }
      throw error;
    }
  }
}
```

### 3.4 优雅关闭

**现状**: systemd 重启时直接 SIGTERM，在途请求被中断，队列任务丢失。

**改进**:

```typescript
// core/shutdown/graceful.ts
export function setupGracefulShutdown(app: FastifyInstance) {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[shutdown] received ${signal}, draining...`);

    // 1. 停止接收新请求
    app.server.close();

    // 2. 等待在途请求完成 (最多 30 秒)
    await app.close({ timeout: 30_000 }).catch(() => {});

    // 3. 关闭 BullMQ workers (等待当前任务完成)
    await closeAllWorkers().catch(() => {});

    // 4. 关闭数据库连接池
    await pool.end().catch(() => {});

    // 5. 关闭 Redis 连接
    await redis.quit().catch(() => {});

    console.log("[shutdown] complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
```

### 3.5 深度健康检查

**现状**: `/health` 只返回固定 JSON，不检查任何依赖。

**改进**:

```typescript
// core/health/probe.ts
app.get("/health", async (_req, reply) => {
  const checks = await Promise.allSettled([
    db.selectFrom("users").select("id").limit(1).execute(),
    redis.ping(),
    checkR2Bucket(),
  ]);

  const status = checks.map((r, i) => ({
    dependency: ["database", "redis", "storage"][i],
    ok: r.status === "fulfilled",
  }));

  const allOk = status.every((s) => s.ok);
  reply.code(allOk ? 200 : 503).send({
    ok: allOk,
    service: "ozon-sjsq-cloud",
    checks: status,
    time: new Date().toISOString(),
  });
});
```

### 3.6 API 版本化

**现状**: 路由无版本前缀，破坏性变更无法灰度。

**改进**: 所有路由加 `/api/v1` 前缀：

```typescript
// app.ts
await app.register(async (api) => {
  await api.register(authRoutes, { prefix: "/api/v1" });
  await api.register(galleryRoutes, { prefix: "/api/v1" });
  // ...
}, { prefix: "" });

// 旧路由保持兼容，标记 deprecated
app.get("/health", ...); // 不加前缀，健康检查不需要版本
```

---

## 四、分阶段迁移计划

### 阶段 1: 搭建骨架（~1 周）

**目标**: 建立新目录结构和基础设施，不改变任何业务逻辑。

**步骤**:
1. 创建 `core/` 目录，将 `config.ts`、`db.ts`、`errors.ts`、`auth.ts`、`rate-limit.ts`、`security.ts` 移入
2. 创建 `modules/` 目录结构（空目录 + index.ts 桩文件）
3. 创建 `infrastructure/` 目录，将 `storage.ts` 移入并重命名为 `storage/adapter.ts`
4. 引入 Kysely，生成数据库类型定义
5. 移除 `index.ts` 和 `gallery-routes.ts` 的 `@ts-nocheck`，修复类型错误
6. 添加 `/api/v1` 前缀到所有路由注册
7. `index.ts` 拆分为 `app.ts`（组装）+ `server.ts`（启动）
8. 添加优雅关闭和深度健康检查

**验收标准**:
- `npm run check` 通过（TypeScript 编译无错误）
- `npm run smoke` 通过
- 线上服务行为不变

### 阶段 2: 拆分核心模块（~2-3 周）

**目标**: 将扁平路由文件逐个迁移到模块化结构。

**迁移顺序**（从简单到复杂）:
1. `auth-routes.ts` (233 行) → `modules/auth/`
2. `shop-routes.ts` → `modules/shop/`
3. `order-routes.ts` (239 行) → `modules/order/`
4. `task-routes.ts` (198 行) → `modules/task/`
5. `ai-routes.ts` (127 行) → `modules/ai/`
6. `mockup-routes.ts` (435 行) + `mockup-renderer.ts` + `mockup-template-service.ts` → `modules/mockup/`
7. `product-catalog-routes.ts` (249 行) → `modules/product-catalog/`
8. `gallery-auto-listing-routes.ts` (516 行) + `auto-listing-planner.ts` + `auto-listing-reservation.ts` → `modules/listing/`
9. `admin-routes.ts` (1,147 行) → `modules/admin/`
10. **`gallery-routes.ts` (5,712 行)** → `modules/gallery/`（此步最重，需进一步拆分）
11. `featured-gallery.ts` → `modules/gallery/services/featured.service.ts`

**gallery-routes.ts 拆分策略**:
```
modules/gallery/
├── routes.ts                      # 路由注册入口
├── controllers/
│   ├── upload.controller.ts       # 上传相关端点
│   ├── list.controller.ts         # 列表/筛选端点
│   ├── featured.controller.ts     # 精选图库端点
│   ├── title-generation.controller.ts  # AI 标题端点
│   └── listing.controller.ts      # 上架关联端点
├── services/
│   ├── upload.service.ts          # 上传编排
│   ├── image-prepare.service.ts   # Sharp 处理
│   ├── dedup.service.ts           # SHA256 去重
│   ├── thumbnail.service.ts       # 缩略图生成
│   ├── title-generation.service.ts # AI 标题逻辑
│   └── featured.service.ts        # 精选图库逻辑
├── repositories/
│   ├── asset.repository.ts        # gallery_assets 表
│   └── query.repository.ts        # 复杂查询/筛选
├── schemas/
│   ├── upload.schema.ts
│   └── list-query.schema.ts
├── events/
│   └── gallery.events.ts
└── index.ts
```

**每个模块迁移的步骤**:
1. 创建模块目录结构
2. 将路由处理函数中的 Zod schema 移入 `schemas/`
3. 将 SQL 查询移入 `repositories/`，用 Kysely 重写
4. 将业务逻辑移入 `services/`
5. 创建 `controllers/`，只做 HTTP 适配
6. 创建 `routes.ts`，注册路由并绑定 schema + preHandler
7. 在 `app.ts` 中注册新模块路由
8. 运行 smoke 测试 + 新增模块单元测试
9. 删除旧文件

**验收标准**:
- 每个模块迁移完成后 `npm run check` 和 `npm run smoke` 通过
- API 响应格式不变（客户端无需改动）
- 每个模块至少有 service 层的单元测试

### 阶段 3: 引入任务队列（~1 周）

**目标**: 用 BullMQ 替代进程内状态管理。

**步骤**:
1. 安装 `bullmq`，创建 Redis 连接
2. 实现任务生产者:
   - `title-generation.producer.ts` — 替代 `titleGenerationQueue` 数组
   - `batch-upload.producer.ts` — 替代 `uploadTaskQueue` 数组
   - `cleanup.producer.ts` — 替代 systemd timer 脚本
3. 实现任务消费者 (Worker):
   - 配置全局并发限制
   - 配置用户级并发限制（通过 BullMQ 的 `limiter` 选项）
4. 在 gallery service 中调用 producer 而非直接执行
5. 配置任务重试策略和死信队列

**验收标准**:
- 进程重启后，正在排队的任务自动恢复执行
- 全局并发限制行为与之前一致
- 可通过 BullMQ Board 查看任务状态

### 阶段 4: 增强可观测性（~1 周）

**目标**: 建立完整的监控和运维能力。

**步骤**:
1. 添加 `/metrics` 端点，输出 Prometheus 格式指标:
   - HTTP 请求计数 + 延迟直方图
   - DB 查询计数 + 延迟
   - BullMQ 队列深度
   - 内存使用 + 事件循环延迟
2. 为 AI API 和 R2 调用添加熔断器
3. 配置 Pino 结构化日志 + 请求关联 ID
4. 配置日志轮转和聚合（systemd journal 或 ELK）
5. 完善 Nginx 配置 — 添加 upstream 多实例负载均衡（预留）

**验收标准**:
- `/metrics` 端点返回 Prometheus 格式指标
- 健康检查覆盖 DB + Redis + R2 三个依赖
- 日志包含 requestId 字段，可全链路追踪
- 外部服务故障时熔断器自动触发，不影响核心功能

---

## 五、部署架构演进

### 5.1 当前部署（保持不变）

```
互联网 → Nginx (80/443) → Fastify (127.0.0.1:8787) → PostgreSQL
                                                         → Cloudflare R2
```

### 5.2 重构后部署（阶段 1-4 完成后）

```
互联网 → Nginx (80/443) → Fastify 主进程 (8787)
                              ├── PostgreSQL 16
                              ├── Redis 7 (缓存 + 限流 + 队列)
                              ├── BullMQ Worker 进程 (8788) ← 可独立扩展
                              └── Cloudflare R2
```

### 5.3 未来水平扩展（按需）

```
互联网 → Nginx (负载均衡)
         ├── Fastify 实例 1 (8787)
         ├── Fastify 实例 2 (8787)     ← 无状态，可加机器
         ├── BullMQ Worker 1 (独立部署)
         ├── BullMQ Worker 2 (独立部署) ← 按队列深度扩缩
         ├── PostgreSQL (主从)
         └── Redis Cluster
```

由于模块化架构下 Fastify 主进程无状态（并发状态已移至 BullMQ/Redis），可以直接水平扩展。

---

## 六、技术选型补充

| 组件 | 选型 | 理由 |
|------|------|------|
| SQL 查询构建器 | Kysely | 纯 TS，无 ORM 抽象泄漏，类型安全，生成可控 SQL |
| 任务队列 | BullMQ | 基于 Redis（已有），API 成熟，支持重试/延迟/定时/流程 |
| 熔断器 | 自实现 | 逻辑简单，无需额外依赖，可根据业务定制 |
| 日志 | Pino (已有) | Fastify 内置，只需补充结构化字段和关联 ID |
| 指标 | prom-client | Prometheus 官方 Node.js 客户端 |
| 优雅关闭 | 自实现 | Fastify 内置 close，补充 DB/Redis/Worker 清理 |
| Docker | Dockerfile + docker-compose | 开发环境一键启动 PG + Redis + Server + Worker |

---

## 七、风险控制

| 风险 | 缓解措施 |
|------|----------|
| 重构期间引入 bug | 每个模块迁移后跑 smoke 测试 + 新增单元测试，API 响应格式不变 |
| 迁移时间过长 | 按模块独立迁移，每次合并一个完整模块，随时可停 |
| Kysely 学习成本 | API 接近原生 SQL，团队已有 pg 经验，迁移门槛低 |
| BullMQ 引入 Redis 依赖 | Redis 已在架构中（限流用），不增加新依赖 |
| 线上服务中断 | 每次合并都在测试环境验证，生产环境灰度切换 |

---

## 八、验收标准

重构完成后应满足以下全部条件：

- [ ] `server/src/` 下没有超过 500 行的 `.ts` 文件
- [ ] 没有 `@ts-nocheck` 标记
- [ ] `npm run check` 零错误
- [ ] 每个模块的 service 层有单元测试覆盖
- [ ] 进程重启后 BullMQ 队列中的任务自动恢复
- [ ] `/health` 返回所有依赖的检查状态
- [ ] `/metrics` 返回 Prometheus 格式指标
- [ ] 外部服务故障时熔断器触发，核心功能不受影响
- [ ] 优雅关闭：SIGTERM 后在途请求完成再退出
- [ ] API 响应格式与重构前完全一致（客户端零改动）
- [ ] RBAC：member 用户无法访问 6 个测试中功能的 API 和菜单
- [ ] RBAC：beta/admin 用户可以正常访问全部功能
- [ ] RBAC：管理员可以通过 API 授予/撤销用户的功能权限
- [ ] RBAC：前端菜单根据 `/api/v1/auth/me` 返回的 features 动态过滤

---

## 九、RBAC 角色权限控制

### 9.1 背景与需求

部分功能（图片上传、待上传图片、上传中、已上传图片、精品图库、自动上品方案）仍在测试阶段，需要限制为少部分用户可用。通过角色 + 功能标识的双重控制机制，实现按角色和按用户两种粒度的菜单/接口可见性管理。

### 9.2 角色定义

| 角色 | 说明 | 权限范围 |
|------|------|----------|
| `member` | 普通用户（默认） | 仅可见基础功能（首页、素材工具、店铺管理、订单、任务记录、兑换密钥） |
| `beta` | 测试用户（新增） | 在 member 基础上，可访问所有标记为测试中的功能 |
| `admin` | 管理员 | 全部功能 + 管理后台 + 用户角色/权限管理 |

当前 `auth.ts` 中的 `CurrentUser` 类型需要扩展：

```typescript
export interface CurrentUser {
  id: string;
  phone: string;
  role: "member" | "beta" | "admin";  // 新增 beta
  deviceId: string;
  membershipPlan: string | null;
  membershipExpiresAt: string | null;
  features: string[];  // 新增：用户可访问的功能标识列表
}
```

### 9.3 数据库设计

迁移文件：`migrations/031_rbac_feature_flags.sql`

#### 表 1: feature_flags（功能标识）

```sql
CREATE TABLE feature_flags (
  key           TEXT PRIMARY KEY,          -- 功能标识，如 'gallery.upload'
  label         TEXT NOT NULL,             -- 显示名称，如 '图片上传'
  module        TEXT NOT NULL,             -- 所属模块，如 '素材' / '上架'
  description   TEXT,                      -- 功能描述
  default_roles TEXT[] NOT NULL DEFAULT '{}', -- 默认可访问的角色列表
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### 表 2: user_feature_access（用户个人功能授权）

```sql
CREATE TABLE user_feature_access (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key  TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  granted_by   UUID REFERENCES users(id),     -- 授予者
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,                    -- 过期时间（NULL = 永久）
  revoked_at   TIMESTAMPTZ,                    -- 撤销时间（NULL = 未撤销）
  PRIMARY KEY (user_id, feature_key)
);
```

#### 初始功能标识数据

| key | label | module | default_roles |
|-----|-------|--------|---------------|
| `gallery.upload` | 图片上传 | 素材 | {beta, admin} |
| `gallery.pending` | 待上传图片 | 素材 | {beta, admin} |
| `gallery.processing` | 上传中 | 素材 | {beta, admin} |
| `gallery.uploaded` | 已上传图片 | 素材 | {beta, admin} |
| `gallery.featured` | 精品图库 | 素材 | {beta, admin} |
| `listing.auto_plans` | 自动上品方案 | 上架 | {beta, admin} |

其余菜单项（首页、转3:4水印、GPT图片生成、AI生成标题、图片重命名、店铺管理、订单查询、任务记录、兑换密钥）无 feature_key，默认所有角色可见。

### 9.4 权限校验逻辑

#### 中间件：requireFeature

```typescript
// core/auth/feature-middleware.ts
import { pool } from "../database/pool.js";
import { AppError } from "../errors/AppError.js";
import type { FastifyRequest } from "fastify";

const featureFlagCache = new Map<string, { defaultRoles: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 分钟缓存

async function getFeatureFlag(featureKey: string) {
  const cached = featureFlagCache.get(featureKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  const result = await pool.query(
    "SELECT default_roles FROM feature_flags WHERE key = $1 AND is_active = true",
    [featureKey]
  );
  if (result.rows.length === 0) return null;
  const flag = {
    defaultRoles: result.rows[0].default_roles,
    fetchedAt: Date.now(),
  };
  featureFlagCache.set(featureKey, flag);
  return flag;
}

export function requireFeature(featureKey: string) {
  return async (request: FastifyRequest) => {
    const user = request.currentUser;
    if (!user) {
      throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    }

    // admin 始终放行
    if (user.role === "admin") return;

    // 检查角色默认权限
    const flag = await getFeatureFlag(featureKey);
    if (!flag) {
      throw new AppError(403, "FEATURE_NOT_FOUND", "功能不存在或已下线");
    }
    if (flag.defaultRoles.includes(user.role)) return;

    // 检查个人授权
    const access = await pool.query(
      `SELECT 1 FROM user_feature_access
       WHERE user_id = $1 AND feature_key = $2
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [user.id, featureKey]
    );
    if (access.rows.length === 0) {
      throw new AppError(403, "FEATURE_FORBIDDEN", "您暂无权限使用此功能");
    }
  };
}
```

#### 路由绑定示例

```typescript
// modules/gallery/routes.ts
import { requireAuth } from "../../core/auth/middleware.js";
import { requireFeature } from "../../core/auth/feature-middleware.js";

app.get("/api/v1/gallery/upload",
  { preHandler: [requireAuth, requireFeature("gallery.upload")] },
  uploadController.getList
);

app.post("/api/v1/gallery/upload",
  { preHandler: [requireAuth, requireFeature("gallery.upload")] },
  uploadController.create
);

// modules/listing/routes.ts
app.get("/api/v1/listing/auto-plans",
  { preHandler: [requireAuth, requireFeature("listing.auto_plans")] },
  planController.list
);
```

### 9.5 API 设计

#### 用户信息接口（扩展）

```
GET /api/v1/auth/me
```

响应新增 `features` 字段：

```json
{
  "user": {
    "id": "...",
    "phone": "...",
    "role": "member",
    "membershipPlan": "...",
    "membershipExpiresAt": "..."
  },
  "features": ["gallery.upload", "gallery.pending"]
}
```

`features` 数组的计算逻辑：
1. `admin` 角色返回 `["*"]`（全部功能）
2. `beta` 角色返回所有 `is_active = true` 的 feature_keys
3. `member` 角色返回该用户在 `user_feature_access` 中有效的 feature_keys
4. 合并角色默认权限和个人授权（取并集）

#### 管理接口

```
GET    /api/v1/admin/features                      列出所有功能标识
GET    /api/v1/admin/users                          用户列表（含角色）
PUT    /api/v1/admin/users/:id/role                 修改用户角色
       Body: { "role": "member" | "beta" | "admin" }
GET    /api/v1/admin/users/:id/features             查看用户功能授权
POST   /api/v1/admin/users/:id/features             授予功能权限
       Body: { "featureKey": "gallery.upload", "expiresAt": "2026-12-31T23:59:59Z" }
DELETE /api/v1/admin/users/:id/features/:featureKey 撤销功能权限
```

所有管理接口需要 `requireAdminToken` 中间件（已有）。

### 9.6 前端菜单过滤机制

#### 前端 PageKey → Feature Key 映射

```typescript
// src/workspace/featurePermissions.ts

export const PAGE_FEATURE_MAP: Partial<Record<PageKey, string>> = {
  imageUpload:      "gallery.upload",
  imagePending:     "gallery.pending",
  imageProcessing:  "gallery.processing",
  imageUploaded:    "gallery.uploaded",
  imageFeatured:    "gallery.featured",
  autoListingPlans: "listing.auto_plans",
};

export function filterModulesByFeatures(
  modules: readonly WorkspaceModule[],
  features: Set<string>
): WorkspaceModule[] {
  // features 包含 "*" 表示全部权限
  if (features.has("*")) return [...modules];

  return modules
    .map((mod) => ({
      ...mod,
      pages: mod.pages.filter((page) => {
        const featureKey = PAGE_FEATURE_MAP[page.key];
        if (!featureKey) return true; // 无 featureKey 的页面默认可见
        return features.has(featureKey);
      }),
    }))
    .filter((mod) => mod.pages.length > 0); // 过滤掉空模块
}
```

#### 前端集成

```typescript
// src/App.tsx 或全局状态管理
const { user, features } = useCloudAuth(); // 从 /api/v1/auth/me 获取

const visibleModules = useMemo(
  () => filterModulesByFeatures(workspaceModules, new Set(features)),
  [features]
);

// 侧边栏只渲染 visibleModules
```

#### 前端直接访问 URL 的保护

即使用户直接输入 URL 访问受限页面，前端也需要拦截：

```typescript
// 路由守卫
function PageGuard({ pageKey, children }: { pageKey: PageKey; children: React.ReactNode }) {
  const { features } = useCloudAuth();
  const featureKey = PAGE_FEATURE_MAP[pageKey];

  if (featureKey && !features.has("*") && !features.has(featureKey)) {
    return <NoPermissionPage />;
  }
  return <>{children}</>;
}
```

### 9.7 目录结构补充

在 `core/auth/` 下新增权限相关文件：

```
core/auth/
├── middleware.ts              # requireAuth / requireMembership (已有)
├── feature-middleware.ts      # requireFeature (新增)
├── feature-service.ts         # 功能标识缓存 + 用户权限计算 (新增)
├── token.ts                   # JWT 签发/验证 (已有)
└── types.ts                   # CurrentUser 类型 (扩展 features 字段)
```

在 `modules/admin/` 下新增权限管理接口：

```
modules/admin/
├── controllers/
│   ├── user-role.controller.ts       # 用户角色管理 (新增)
│   └── feature-access.controller.ts  # 功能授权管理 (新增)
├── services/
│   ├── role.service.ts               # 角色变更逻辑 (新增)
│   └── feature-access.service.ts     # 授权/撤销逻辑 (新增)
├── repositories/
│   ├── feature-flag.repository.ts    # feature_flags 表操作 (新增)
│   └── user-feature-access.repository.ts # user_feature_access 表操作 (新增)
└── routes.ts                         # 注册管理路由
```

### 9.8 迁移步骤

RBAC 功能可以独立于架构重构先行实施，不影响现有代码：

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | 执行 `031_rbac_feature_flags.sql` 迁移 | 无 |
| 2 | 扩展 `CurrentUser` 类型，加入 `role: "beta"` 和 `features: string[]` | 步骤 1 |
| 3 | 实现 `feature-service.ts`（权限计算 + 缓存） | 步骤 1 |
| 4 | 实现 `requireFeature` 中间件 | 步骤 3 |
| 5 | 扩展 `/api/v1/auth/me` 接口，返回 `features` 数组 | 步骤 3 |
| 6 | 在 6 个测试中功能的路由上挂载 `requireFeature` | 步骤 4 |
| 7 | 实现管理接口（角色变更、功能授权/撤销） | 步骤 3 |
| 8 | 前端添加 `featurePermissions.ts` + 菜单过滤 | 步骤 5 |
| 9 | 前端添加路由守卫 + 无权限提示页 | 步骤 8 |
| 10 | 将需要测试权限的用户角色改为 `beta`，或通过管理接口单独授权 | 步骤 7 |

**关键设计决策**：

- **feature_flags 缓存**：功能标识变更频率极低，中间件内置 60 秒内存缓存，避免每次请求查库
- **个人授权覆盖角色**：`member` 用户也可通过 `user_feature_access` 单独开通某个功能，无需改角色。这比改角色更精细
- **expires_at 字段**：个人授权支持设置过期时间，适合临时测试场景
- **is_active 全局开关**：功能上线后只需 `UPDATE feature_flags SET is_active = true` 即可对所有人开放，或 `SET default_roles = '{member, beta, admin}'` 直接纳入普通角色
- **前端双重保护**：菜单过滤（用户看不到入口）+ 路由守卫（直接访问 URL 也拦截）+ 后端中间件（API 层面兜底）

### 9.9 前端管理页面设计

RBAC 功能需要配套的管理界面，让管理员在页面上直接操作用户角色和功能授权，而非通过手动改数据库。

#### 页面挂载

在 `navigation.ts` 中新增 `adminUsers` 页面，挂载在"任务/设置"模块下，**仅 admin 角色可见**：

```typescript
// navigation.ts 扩展
export type PageKey =
  | 'dashboard'
  | 'materialPortrait'
  // ... 现有 key
  | 'license'
  | 'adminUsers'      // 新增
  | 'adminFeatures'   // 新增 (功能开关管理)
  | 'adminLogs';      // 新增 (操作日志)

// 在 tasks 模块下新增 admin 专属页面
{
  key: 'tasks',
  label: '任务/设置',
  pages: [
    { key: 'jobs', label: '任务记录' },
    { key: 'license', label: '兑换密钥' },
    // 以下页面仅 admin 可见，通过 filterModulesByFeatures 过滤
    { key: 'adminUsers', label: '用户管理' },
    { key: 'adminFeatures', label: '功能开关' },
    { key: 'adminLogs', label: '操作日志' },
  ],
}
```

#### 菜单可见性控制

admin 专属页面通过 `PAGE_FEATURE_MAP` 统一控制：

```typescript
// featurePermissions.ts 扩展
export const PAGE_FEATURE_MAP: Partial<Record<PageKey, string>> = {
  // ... 现有测试功能映射
  imageUpload:      "gallery.upload",
  // ...
  adminUsers:       "admin.panel",       // 新增
  adminFeatures:    "admin.panel",       // 新增
  adminLogs:        "admin.panel",       // 新增
};

// feature_flags 表初始化数据中新增
-- admin.panel 功能：仅 admin 角色可见
INSERT INTO feature_flags (feature_key, module, label, description, default_roles, is_active)
VALUES ('admin.panel', 'admin', '管理后台', '用户角色与功能权限管理', '{admin}', true);
```

#### 用户管理页面 (AdminUsersPage)

**页面结构**：

```
┌─────────────────────────────────────────────────┐
│ [用户管理] [功能开关] [操作日志]    ← Tab 切换    │
├─────────────────────────────────────────────────┤
│  187        162        21         4             │
│ 总用户数   member    beta      admin  ← 统计卡片 │
├─────────────────────────────────────────────────┤
│ [搜索手机号/用户名] [全部角色 ▼]     [导出CSV]   │
├─────────────────────────────────────────────────┤
│ 用户          角色      会员状态    功能授权  操作│
│ 138****8888   [admin]   年度·有效  全部功能  —   │
│ 139****2222   [beta]    月度·有效  全部测试  改角色 授权│
│ 137****5566   [member]  季度·到期  2项已授权 改角色 授权│
│ 135****7788   [member]  无会员     0项       改角色 授权│
├─────────────────────────────────────────────────┤
│ 共 187 用户 · 第 1/19 页         < 1 [2] 3 >   │
└─────────────────────────────────────────────────┘
```

**"改角色"下拉菜单**（点击展开）：

```
┌─────────────────────────┐
│ ● 管理员 (admin)   当前  │
│ ○ 测试用户 (beta)        │
│ ○ 普通用户 (member)      │
└─────────────────────────┘
```

选择后调用 `PUT /api/v1/admin/users/:id/role`，成功后：
- 用户列表中角色 Badge 立即更新
- 弹出 Toast 提示"角色已更新"
- 该用户下次登录时 `features` 数组自动变化，菜单随之改变

**"功能授权"弹窗**（点击弹出 Modal）：

```
┌─────────────────────────────────────────────────┐
│ 功能授权 — 137****5566 (王用户)            ×   │
├─────────────────────────────────────────────────┤
│ 测试中功能 (共 6 项)                             │
│                                                 │
│ ☑ 图片上传      gallery.upload      永久有效    │
│ ☑ 待上传图片    gallery.pending     2026-09-30到期│
│ ☐ 上传中        gallery.processing  未授权      │
│ ☐ 已上传图片    gallery.uploaded    未授权      │
│ ☐ 精品图库      gallery.featured    未授权      │
│ ☐ 自动上品方案  listing.auto_plans  未授权      │
│                                                 │
│ 勾选后可选: [永久] [7天] [30天] [自定义日期]     │
├─────────────────────────────────────────────────┤
│                          [取消]  [保存授权]      │
└─────────────────────────────────────────────────┘
```

**操作逻辑**：
- 勾选功能 → 调用 `POST /api/v1/admin/users/:id/features`，Body 含 `featureKey` 和可选 `expiresAt`
- 取消勾选 → 调用 `DELETE /api/v1/admin/users/:id/features/:featureKey`
- 保存后弹窗关闭，用户列表"功能授权"列数字更新
- 已授权项显示绿色状态（永久有效 / 到期日期），未授权项灰色

#### 功能开关页面 (AdminFeaturesPage)

管理 `feature_flags` 表的全局开关，用于功能上线/下线控制：

```
┌─────────────────────────────────────────────────┐
│ 功能标识管理                                     │
├─────────────────────────────────────────────────┤
│ 功能Key          模块    名称        默认角色  状态│
│ gallery.upload   素材    图片上传    [beta]   开启│
│ gallery.pending  素材    待上传图片  [beta]   开启│
│ listing.auto_plans 上架  自动上品方案 [beta]   开启│
│ admin.panel      管理    管理后台    [admin]  开启│
├─────────────────────────────────────────────────┤
│ 点击"默认角色"可编辑哪些角色默认可见该功能        │
│ 点击"状态"开关可一键上线/下线功能               │
└─────────────────────────────────────────────────┘
```

**关键操作**：
- 功能正式上线：将 `default_roles` 改为 `{member, beta, admin}`，所有用户立即获得权限
- 紧急下线：将 `is_active` 改为 `false`，即使已授权用户也无法访问
- 修改后 60 秒内全量生效（中间件缓存 TTL）

#### 操作日志页面 (AdminLogsPage)

记录所有权限变更操作，便于审计：

```
┌─────────────────────────────────────────────────┐
│ 操作日志                                        │
├─────────────────────────────────────────────────┤
│ 时间          操作人      操作      目标用户     │
│ 14:32:15     张管理员    改角色    137****5566   │
│                        member → beta            │
│ 14:28:03     张管理员    授权      137****5566   │
│                        gallery.upload (永久)    │
│ 14:15:42     张管理员    撤销授权   139****2222  │
│                        gallery.featured         │
└─────────────────────────────────────────────────┘
```

日志表设计（可后续添加到迁移中）：

```sql
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(40) NOT NULL,        -- 'role_change' | 'feature_grant' | 'feature_revoke'
  target_user_id UUID REFERENCES users(id),
  feature_key VARCHAR(80),
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_created ON admin_audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_target ON admin_audit_logs(target_user_id);
```

#### 前端组件结构

```
src/features/admin/
├── AdminUsersPage.tsx          # 用户管理页面
├── AdminFeaturesPage.tsx       # 功能开关页面
├── AdminLogsPage.tsx           # 操作日志页面
├── components/
│   ├── UserTable.tsx           # 用户列表表格
│   ├── RoleSelectDropdown.tsx  # 改角色下拉菜单
│   ├── FeatureAccessModal.tsx  # 功能授权弹窗
│   └── FeatureToggleTable.tsx  # 功能开关表格
└── hooks/
    ├── useAdminUsers.ts        # 用户列表分页/搜索
    ├── useUserRole.ts          # 改角色 mutation
    └── useFeatureAccess.ts     # 授权/撤销 mutation
```

#### 交互细节

| 场景 | 行为 |
|------|------|
| admin 用户降级自己 | 弹确认框警告"您将失去管理权限"，确认后执行，下次登录生效 |
| 改角色后用户在线 | 用户下次请求 `/api/v1/auth/me` 时拿到新 `features`，前端自动刷新菜单 |
| 授权弹窗中切换过期时间 | 已勾选项的过期时间联动更新，无需重新勾选 |
| 批量操作 | 用户列表支持多选，批量改角色 / 批量授权（后续迭代） |
| 权限变更通知 | 可选：WebSocket 推送通知目标用户"您的权限已更新"（后续迭代） |
