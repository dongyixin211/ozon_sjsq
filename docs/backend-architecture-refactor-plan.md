# Ozon SJSQ 后端架构重构方案

> **版本**: 1.0
> **日期**: 2026-08-08
> **范围**: server/ 后端工程
> **目标**: 从扁平单文件结构重构为分层模块化架构，提升扩展性、稳定性、可测试性和团队协作效率

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
