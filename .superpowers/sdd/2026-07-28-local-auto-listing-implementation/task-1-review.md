# Task 1 Review

Verdict: NEEDS_CHANGES

## Summary
- 范围核对：本次实现只涉及 `E:\tool\ozon_sjsq\packages\shared\src\types.ts` 和 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql`，未见 Task 2+ 的额外实现；这一点与 `E:\tool\ozon_sjsq\.superpowers\sdd\2026-07-28-local-auto-listing-implementation\task-1-report.md:31` 一致。
- shared 类型：`OzonUploadQuota`、`AutoListingPlanShopConfig`、`CloudAutoListingPlan` 与 brief 完全对齐；`CloudAutoListingRun` / `CloudAutoListingAssignment` / `ReserveAutoListingBatch*` 采用了与 029 表结构一致的最小字段集，整体足以支撑后续 API 起步。
- SQL 约束：`gallery_auto_listing_assignment_asset_uq` 能在数据库层原子保证“一张图片同一时刻只有一个有效归属”，这一点符合全局唯一性约束。
- 测试结论：实现报告对 `npm run migrate` 未被真实 PostgreSQL 验证的描述是准确的。结合 `E:\tool\ozon_sjsq\server\scripts\migrate.ts:13`、`E:\tool\ozon_sjsq\server\scripts\migrate.ts:18` 与 `E:\tool\ozon_sjsq\.superpowers\sdd\2026-07-28-local-auto-listing-implementation\task-1-report.md:21`，这应记录为风险而不是单独的阻断项；真正阻断本任务通过的是下面的 schema 缺陷。

## Findings

### Critical
- None.

### Important
- 缺少级联删除会让后续计划删除/运行清理失效。`gallery_auto_listing_runs.plan_id` 在 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:27` 使用了 `ON DELETE CASCADE`，但 `gallery_auto_listing_assignments.plan_id` 与 `gallery_auto_listing_assignments.run_id` 在 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:40` 和 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:41` 没有级联动作，默认是 `NO ACTION`。一旦 assignment 已存在，删除 plan 时 runs 的级联删除会被 assignments 反向拦住，后续 Task 3 计划中的删除接口无法可靠工作（见 `E:\tool\ozon_sjsq\docs\superpowers\plans\2026-07-28-local-auto-listing-implementation.md:278`）。这不是风格问题，而是会直接影响后续 API 能否落地的 schema 缺陷。

### Minor
- `status` 列缺少数据库级 `CHECK`，会让表接受任意字符串状态。当前 shared 已定义 `AutoListingAssignmentStatus` 枚举于 `E:\tool\ozon_sjsq\packages\shared\src\types.ts:247`，但 `status text NOT NULL` 仍出现在 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:30` 与 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:45`。这不会立刻破坏唯一性，但会增加后续 API/调度器的防御负担，也让“CHECK 是否合理”这一项只能算部分达标。
- `CloudAutoListingRun.status` 目前是宽泛的 `string`，精度弱于 assignment 的状态类型。见 `E:\tool\ozon_sjsq\packages\shared\src\types.ts:294`。这在 Task 1 不阻断，但若后续 API 要返回固定运行态，建议补成命名 union，避免前后端状态字面量漂移。

## Requirement-by-requirement Check
- Task 1 要求是否全部实现：未全部实现为“可批准状态”。文件范围和接口名称已完成，但 029 的删除语义存在重要缺陷，因此不能判定为 fully compliant。
- 是否有额外范围：未发现超出“shared 类型 + 029 迁移”的实现范围。
- shared 类型是否足以支撑后续 API：基本足够；命名与 snake_case -> camelCase 映射一致，可选性也与 `title_prompt_template_*`、`batch_id`、`last_error`、`released_at` 的可空语义一致。
- SQL 外键/表名/索引/幂等性是否合理：现有表名引用正确，部分唯一索引正确，幂等性从静态 SQL 角度看合理；但 assignments 的外键删除动作不合理，且状态列缺少 `CHECK`。
- 实现报告测试结论是否准确：准确地说明了 build/check 通过、migrate 未真实验证。缺少本地 PostgreSQL 本身应记为风险，不应单独作为阻断；阻断来自 schema 设计问题。

## Re-review (Fix Round 1)

Verdict: APPROVED

- `gallery_auto_listing_assignments.plan_id` 与 `gallery_auto_listing_assignments.run_id` 已补上级联删除，见 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:40` 和 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:41`。
- `gallery_auto_listing_runs.status` 与 `gallery_auto_listing_assignments.status` 已增加数据库级 `CHECK` 约束，见 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:30` 和 `E:\tool\ozon_sjsq\server\migrations\029_auto_listing_plans.sql:45`。
- `CloudAutoListingRun.status` 已收紧为显式 `AutoListingRunStatus` union，见 `E:\tool\ozon_sjsq\packages\shared\src\types.ts:257` 和 `E:\tool\ozon_sjsq\packages\shared\src\types.ts:302`。
- 本次 scoped re-review 仅核对上述三项历史问题；三项均已解决，未发现残留问题。
