# Task 3 Independent Review: Cloud Plan and Reservation API

Date: 2026-07-28

## Verdict

**NEEDS_CHANGES**

Task 3 的基础 API、用户条件、事务包装、自动分配表唯一索引、状态守卫和 CloudClient 路径整体已落地，服务端测试与类型检查也通过。但当前实现仍有三项会破坏设计核心一致性的缺陷：手工上架可绕过自动归属、活动运行没有不可变店铺配置快照、补充预留不会按已有待处理量恢复店铺均衡。

## Findings

### Critical

1. **手工批次创建可以绕过自动分配的全局 source asset 归属。**
   - 自动预留只在 `server/src/routes/gallery-auto-listing-routes.ts:269` 排除未释放的自动 assignment，并在 `server/migrations/029_auto_listing_plans.sql:53` 对自动 assignment 表建立 `source_asset_id` 部分唯一索引。
   - 反向路径没有建立：`server/src/routes/gallery-routes.ts:2579` 的手工批次原图查询没有检查 `gallery_auto_listing_assignments`，`server/src/routes/gallery-routes.ts:2692` 的占用检查也只检查 `gallery_usage` 和 `gallery_listing_batch_assets`。
   - 因此，一张已自动预留给店铺 A 的原图，仍可随后进入店铺 B 的手工批次；自动 assignment 表上的唯一索引无法约束另一个表。并发时手工路径也没有在事务内锁定 source asset 行，无法与自动预留的 `FOR UPDATE` 形成互斥。
   - 这直接违反设计中的“一张原图全局只能分配给一个店铺”和“人工上架和自动上架共用图片唯一归属检查”。需要让手工批次创建在同一事务内锁定 source asset，并拒绝任何 `released_at IS NULL` 的自动 assignment；同时保留自动预留对手工批次的反向检查。

### Important

2. **活动运行没有不可变的 shop/config snapshot，编辑方案会改变已预留任务的执行配置。**
   - `server/src/routes/gallery-auto-listing-routes.ts:207` 的 PUT 会原地覆盖 `shop_configs`、样机和标题配置，即使该方案已有未完成 assignment。
   - `server/src/routes/gallery-auto-listing-routes.ts:291` 创建 run 时只保存 `quota_snapshot`；`server/src/routes/gallery-auto-listing-routes.ts:397` 的 assignment 也只保存 `external_shop_id`，没有商品模板、模板商品、开关或本地模板快照。
   - 结果是：预留完成后若用户编辑方案、移除店铺或更换商品模板，run/assignment 无法恢复预留时的完整执行配置，只能依赖当前可变方案。这违反“读取配置快照”和 shop snapshot 要求，并会导致重启恢复使用错误配置或找不到原店铺配置。
   - 需要把完整 plan/shop execution snapshot 固化到 run/assignment，或至少在存在未完成 assignment 时禁止修改会影响执行的字段。仅保存在可变 plan 行中不构成运行快照。

3. **补充预留的 round-robin 只平均新增项，不会根据已有 outstanding 数量恢复总体均衡。**
   - `server/src/routes/gallery-auto-listing-routes.ts:244` 已读取各店铺 outstanding 数量，但 `server/src/routes/gallery-auto-listing-routes.ts:279` 仍从 `shopConfigs` 第一个店铺开始平均分配新增候选。
   - `calculateRemainingShopCapacity` 只限制每店容量，不能让较少 outstanding 的店铺优先补齐。实测在目标缓冲 20、A 已有 10、B 已有 0、再补 10 张且两店额度充足时，当前实现新增 A=5/B=5，最终变成 A=15/B=5，而不是优先补给 B。
   - 这不满足“同品类店铺默认平均分配”的滚动补充语义。分配顺序需要纳入当前 outstanding/当日已分配量，优先最低负载店铺，同时继续遵守各店 quota capacity。

### Minor

4. **计划 CRUD 只验证 snapshot 形状，没有验证启用计划引用的店铺属于当前用户。**
   - `server/src/routes/gallery-auto-listing-routes.ts:19` 到 `server/src/routes/gallery-auto-listing-routes.ts:46` 只做 Zod 字段验证，保存时直接把 `shopConfigs` 写入 JSON。
   - 相比之下，手工批次路径在 `server/src/routes/gallery-routes.ts:2548` 到 `server/src/routes/gallery-routes.ts:2566` 会确认 `external_shop_id` 属于当前用户。
   - 当前接口可保存并启用任意或过期的 `externalShopId`，随后占用用户自己的图片但无法可靠执行。建议启用/更新计划时验证所有云端店铺归属；若产品模板 ID 是云端实体，也应验证其用户归属或明确只把它作为不可信 snapshot 字段。

5. **现有测试仅覆盖纯 planner，未覆盖路由级用户隔离和跨流程竞争。**
   - `server/src/auto-listing-planner.test.ts` 的 13 个测试覆盖范围、重复店铺、状态转换、batch 绑定和 release 纯函数，但没有验证 SQL 用户条件、事务回滚、并发 reserve、手工/自动竞争或仅返回成功插入行。
   - Task 8 可以承担真实 PostgreSQL 并发 smoke，但 Task 3 修复上述问题时至少应增加可复现的数据库/路由测试，特别是“自动预留后手工批次必须失败”和“编辑方案不改变活动 run snapshot”。

## Checklist

- 用户隔离：**基本通过，但计划店铺归属验证不足。** plans/runs/assignments/assets/batches 的主要查询均带当前 `user_id`；未发现跨用户读取或更新 assignment/run 的直接路径。
- CRUD 验证：**部分通过。** batchSize 5–20、bufferSize 不超过两批、重复店铺、启用计划至少一个店铺、时间字段范围已验证；关联店铺归属未验证。
- enabled 唯一性：**通过。** 应用层冲突检查加 `gallery_auto_listing_active_rule_uq` 部分唯一索引，`23505` 被转换为 409。
- shop snapshot：**不通过。** plan JSON 是可变配置，不是 run/assignment 的不可变执行快照。
- begin/commit/rollback：**通过。** `withTransaction` 在 `server/src/db.ts:24` 明确执行 BEGIN/COMMIT/ROLLBACK；save/reserve/progress/release 均使用该包装。
- `FOR UPDATE SKIP LOCKED` 候选 SQL：**自动预留路径通过。** 用户、商品类型、软删除、有效 assignment、手工 usage/batch 排除、稳定排序和锁定均存在；但手工路径没有对称锁定/检查。
- 全局 source asset 防重复：**不通过。** 自动对自动安全，手工对自动不安全。
- round-robin 容量：**容量上限通过，总体均衡不通过。** quota、安全预留、总缓冲和 outstanding 扣减存在，但补充时未按已有负载排序。
- 仅成功插入返回：**通过。** `ON CONFLICT DO NOTHING RETURNING *` 后只 push `inserted.rows[0]`。
- 状态转换：**通过当前定义。** 正向阶段、失败恢复、暂停恢复和终态限制均有守卫；batch ID 一旦设置不可清除或替换。
- release untouched guard：**通过基本守卫。** 仅 reserved、无 batch、无标题/样机结果可释放；更新与检查位于同一事务并锁 assignment。
- run list：**通过。** 过滤条件和 assignment 查询均按当前用户隔离，返回嵌套 assignments。
- CloudClient 路径/类型：**通过。** 六个 Task 3 方法及 delete 方法与服务端路径、请求体和共享类型一致。

## Verification

- `server > npm test`: **PASS**，13 tests，0 failed。
- `server > npm run check`: **PASS**，TypeScript `--noEmit` 退出码 0。
- `npm run build:web`: **BLOCKED BY PARALLEL TASK 6/7**。当前错误仅位于 `src/features/cloud/GalleryManager.tsx:5982` 和 `src/features/cloud/GalleryManager.tsx:5985`，缺少 `CloudListingBatchProgressSummary.listingRunning/mockupRunning/titleRunning`；未发现指向 Task 3 `src/lib/cloudApi.ts` 的构建错误，本审查未修改这些并行任务文件。
- 未运行真实 PostgreSQL 集成测试：本地报告已说明数据库环境不可用；因此并发锁和回滚结论来自 SQL/事务代码审查，不能替代 Task 8 的并发 smoke。

## Required Before Approval

1. 在手工批次创建事务中加入与自动 assignment 对称的全局 source asset 占用检查和行锁，消除手工/自动竞争。
2. 为每个 run/assignment 固化完整执行 snapshot，或禁止活动 assignment 存在时修改执行配置。
3. 调整补充预留算法，使 round-robin 基于已有 outstanding/当日分配量恢复总体均衡，并增加对应回归测试。
4. 建议同时补齐启用计划的店铺归属验证和路由/数据库级回归测试。
