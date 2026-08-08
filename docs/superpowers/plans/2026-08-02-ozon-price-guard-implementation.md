# Ozon 活动规则编辑与防亏价格治理 Implementation Plan

> **For agentic workers:** This plan is executed in the current workspace without creating a branch or committing changes.

**Goal:** 让已保存的类目活动规则可编辑并立即校正活动价，同时自动阻止 Ozon 自动加入非受控活动和持续低于规则底价的商品。

**Architecture:** 复用现有店铺自动运维任务和活动规则配置。保存规则后启动一次可追踪的活动价格同步；每轮自动运维读取活动商品、自动加入记录和商品价格信息，先校正受控活动价格，下一轮仍低于规则底价则撤出商品并删除自动加入资格。所有动作写入任务日志并汇总到飞书，不改造现有 V2 云端架构。

**Tech Stack:** Rust/Tauri、本地 SQLite、Ozon Seller API、React/TypeScript、Vitest、Cargo test。

## Global Constraints

- 不提交 git、不创建分支、不扩展已取消的 V2 云端架构。
- Windows 文件写入使用 UTF-8 无 BOM。
- 未配置任何类目活动规则时，禁止执行活动清理。
- 规则价作为卖家活动最低价格；展示价降低但卖家营销价未低于规则价时只通知，不自动移出。
- Ozon 凭证、飞书 Webhook、数据库连接和密钥不写入文档或日志。

### Task 1: 保存官方接口资料与功能索引

**Files:**
- Create: `docs/ozon/official/seller-api-swagger-2026-08-02.json`
- Create: `docs/ozon/official/seller-api-feature-index-2026-08-02.md`

- [ ] 下载官方 Seller API Swagger 2.1 原件并保存校验信息。
- [ ] 按活动、自动加活动、折扣申请、商品价格、库存、商品导入、订单和财务等标签生成接口索引。
- [ ] 在索引中标注本项目已接入、待接入和本次使用的接口。
- [ ] 检查文档不包含店铺 token、Webhook 或本地数据库内容。

### Task 2: 规则编辑与价格保护纯函数

**Files:**
- Modify: `src/features/ozon/OzonPage.tsx`
- Modify: `src-tauri/src/core/listing_maintenance.rs`
- Test: `src-tauri/src/core/listing_maintenance.rs` module tests
- Test: `src/features/ozon/OzonPage.test.tsx`

- [ ] 先添加同类目同活动规则编辑回填、更新而非重复新增的失败测试。
- [ ] 先添加规则价比较、首次校正、连续异常后撤出的失败测试。
- [ ] 给规则表增加编辑操作，复用现有添加/更新逻辑。
- [ ] 实现金额规范化与活动价比较，避免字符串格式造成误判。
- [ ] 为每个活动商品保留一次待核验状态；首次低于底价只校正，下一次仍低于底价才触发撤出。

### Task 3: 接入 Ozon 自动加活动、商品价格与折扣接口

**Files:**
- Modify: `src-tauri/src/core/ozon.rs`
- Modify: `src-tauri/src/core/models.rs`
- Test: `src-tauri/src/core/ozon.rs` or focused helper tests

- [ ] 增加自动加入活动列表、更新和删除请求的客户端方法。
- [ ] 增加 Seller API 商品价格分页读取，解析 `marketing_seller_price`、`min_price`、`price`、`auto_action_enabled` 和营销活动信息。
- [ ] 增加 v2 折扣申请读取和拒绝请求模型；仅对低于规则底价的申请执行拒绝。
- [ ] 保持现有活动加入/移除接口兼容，不修改无关 Ozon API 调用。

### Task 4: 自动运维价格同步与防亏执行

**Files:**
- Modify: `src-tauri/src/core/listing_maintenance.rs`
- Modify: `src-tauri/src/core/jobs.rs`
- Modify: `src-tauri/src/core/feishu_notifications.rs`
- Modify: `src-tauri/src/core/models.rs`
- Test: `src-tauri/src/core/listing_maintenance.rs`

- [ ] 每轮读取受控活动商品，按商品类目匹配规则。
- [ ] 活动价不一致时批量按规则价重新提交，并记录前后价格。
- [ ] 活动价下一轮仍低于规则价时，删除自动加入资格并移出该商品。
- [ ] 非受控活动继续执行现有整活动清理，并额外删除自动加入资格，防止 Ozon 自动加回。
- [ ] 读取卖家营销价；低于规则底价按高风险处理。仅 Ozon 补贴导致的展示价变化不自动移出。
- [ ] 读取并拒绝低于规则底价的折扣申请。
- [ ] 任务摘要汇总同步、移出、拒绝、风险和失败数量，复用飞书最终通知。

### Task 5: 保存规则后立即同步与前端反馈

**Files:**
- Modify: `src-tauri/src/core/commands.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/features/ozon/OzonPage.tsx`
- Test: `src/features/ozon/OzonPage.test.tsx`

- [ ] 保存活动规则后启动一次可追踪的价格同步任务。
- [ ] 前端显示任务 ID、店铺、类目、活动和处理进度。
- [ ] 仍保留定时运维作为后续持续校验，不重复创建同店并发任务。

### Task 6: 集成验证与客户端发布

**Files:**
- Modify: `src-tauri/src/core/db.rs` only if a migration is required by implementation.

- [ ] 运行目标 Rust 测试并验证安全开关、价格纠正和连续异常撤出。
- [ ] 运行全部前端测试和生产构建。
- [ ] 构建 Windows NSIS 客户端并安装到本机。
- [ ] 用无规则店铺验证不会删除活动；用已配置规则店铺验证活动价同步和任务日志。
- [ ] 只有在真实 Ozon 返回价格与活动结果可核对时，才报告真实流程完成。