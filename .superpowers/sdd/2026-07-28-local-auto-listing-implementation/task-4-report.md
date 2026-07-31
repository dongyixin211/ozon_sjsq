# Task 4 Report: Ozon Upload Quota Support

## 完成内容

- 在 `src-tauri/src/core/ozon.rs` 新增可序列化的 `OzonUploadQuota`，字段使用 camelCase 输出。
- 新增 `OzonSellerClient::product_upload_quota()`，调用 `POST /v4/product/info/limit`，请求 body 为 `{}`。
- 解析 `daily_create`、`daily_update`、`total` 的 `limit` 和 `usage`，使用 `saturating_sub` 计算 remaining。
- `limit`/`usage` 缺失、负数或非数字时返回错误，不使用无限额度默认值。
- 解析并验证可选 `reset_at`；`operation_limits` 以原始 JSON 值保留并用于序列化。
- 在 `src-tauri/src/core/commands.rs` 新增 `get_shop_upload_quota(shop_id)`。
- 在 `src-tauri/src/lib.rs` 注册 Tauri command。
- 在 `src-tauri/src/core/local_assistant.rs` 增加同名浏览器助手 command。
- 在 `src/lib/api.ts` 增加 `api.getShopUploadQuota(shopId)`，不提供伪额度 fallback。
- 现有 `src/lib/localAssistantCommandParity.test.ts` 已能自动覆盖新命令，无需修改测试文件。

## 修改文件

- `src-tauri/src/core/ozon.rs`
- `src-tauri/src/core/commands.rs`
- `src-tauri/src/core/local_assistant.rs`
- `src-tauri/src/lib.rs`
- `src/lib/api.ts`
- `.superpowers/sdd/2026-07-28-local-auto-listing-implementation/task-4-report.md`

## RED 证据

1. Rust parser RED：
   - 命令：`cargo test --manifest-path src-tauri/Cargo.toml product_upload_quota`
   - 结果：失败，3 处 `E0425`，原因均为 `parse_product_upload_quota` 不存在。
2. 浏览器命令 parity RED：
   - 命令：`npm test -- src/lib/localAssistantCommandParity.test.ts`
   - 结果：失败，明确报告缺失 `get_shop_upload_quota`。

## GREEN 与测试结果

- `cargo test --manifest-path src-tauri/Cargo.toml product_upload_quota`
  - 通过：3 passed，0 failed。
  - 覆盖：正确剩余量、`operation_limits` 序列化保留、饱和减法、必填字段缺失/负数/非数字拒绝。
- `npm test -- src/lib/localAssistantCommandParity.test.ts`
  - 通过：1 passed，0 failed。

## 限制与阻塞

- 未实际请求 Ozon 线上接口；当前验证覆盖请求代码、解析器和命令链，真实调用仍依赖有效店铺凭据及网络。
- 额外执行的 `cargo check --manifest-path src-tauri/Cargo.toml` 已通过，仅有既存 `local_mockup.rs::read_progress` 未使用警告。
- 全量 `npm run build:web` 被共享工作区中 `src/features/cloud/AutoListingPlansPage.test.tsx` 的既有 TypeScript 语法错误阻断；该文件不在 Task 4 范围内，未修改。
- 全仓 `cargo fmt --check` 被未触碰的 `src-tauri/src/core/order_docs.rs` 既有格式差异阻断；Task 4 涉及的 Rust 文件定向格式检查通过。
- 未提交 Git，未回滚或覆盖其他人的共享工作区修改。
