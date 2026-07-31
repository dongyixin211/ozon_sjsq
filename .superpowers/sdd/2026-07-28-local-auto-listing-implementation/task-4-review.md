# Task 4 Review — Ozon Upload Quota Support

## Verdict

**APPROVED**

未发现需要阻止 Task 4 通过的正确性、接口一致性或测试失败问题。

## Review Basis

- 根级行为准则：按用户消息提供的 `AGENTS.md` 指令执行；工作区根目录未发现实体 `AGENTS.md` 文件。
- 设计：`docs/superpowers/specs/2026-07-28-local-auto-listing-design.md` 第 5 节。
- 实施计划：`docs/superpowers/plans/2026-07-28-local-auto-listing-implementation.md` Task 4。
- 审查范围：
  - `src-tauri/src/core/ozon.rs`
  - `src-tauri/src/core/commands.rs`
  - `src-tauri/src/core/local_assistant.rs`
  - `src-tauri/src/lib.rs`
  - `src/lib/api.ts`
  - `src/lib/localAssistantCommandParity.test.ts`
- 为确认前端返回类型一致性，只读核对了 `packages/shared/src/types.ts` 中的 `OzonUploadQuota`，未修改任何实现文件。

## Requirement Verification

### 1. POST endpoint and empty body

- `OzonSellerClient::product_upload_quota()` 调用 `request_json(/v4/product/info/limit, json!({}))`。
- `request_json` 使用 HTTP `POST` 并通过 `.json(&payload)` 发送 JSON，因此请求体为 `{}`。
- 结论：满足 `POST /v4/product/info/limit` body `{}`。

### 2. Strict required numeric validation

- `daily_create.limit`、`daily_create.usage`、`daily_update.limit`、`daily_update.usage`、`total.limit`、`total.usage` 全部通过 `required_quota_value` 读取。
- `required_quota_value` 使用 `Value::as_u64`，缺失、`null`、字符串、布尔值、浮点/分数及其他非无符号整数均返回错误，不会回退为超大额度或默认无限值。
- 现有测试覆盖必填字段缺失和字符串值拒绝。
- 结论：满足严格 required 数值校验要求。

### 3. Negative values rejected

- 负数无法通过 `Value::as_u64`，解析返回错误。
- 现有测试包含 `daily_update.usage = -1` 并断言解析失败。
- 结论：满足负数拒绝要求。

### 4. Saturating subtraction

- 创建、更新、总容量的 remaining 均使用 `saturating_sub`。
- 现有测试覆盖 usage 大于 limit，并验证三个 remaining 均为 `0`，无下溢。
- 结论：满足 saturating subtraction 要求。

### 5. `operation_limits` preservation

- 解析器通过 `root.get(operation_limits).cloned()` 原样保留未知 JSON 内容。
- `OzonUploadQuota` 以 `Option<Value>` 存储，并经 camelCase 序列化为 `operationLimits`。
- 现有测试验证 `[{ operation: product_import, limit: 100 }]` 序列化后内容不变。
- 结论：满足操作级限额保留及前向兼容要求。

### 6. Tauri / local assistant / browser parity

- Tauri command：`get_shop_upload_quota(shop_id)` 已定义，并调用同一个 `OzonSellerClient::product_upload_quota()`。
- Tauri registration：`src-tauri/src/lib.rs` 的 `generate_handler!` 已注册 `get_shop_upload_quota`。
- Local assistant：`src-tauri/src/core/local_assistant.rs` 已分派字符串命令 `get_shop_upload_quota`，参数名为 `shopId`，与浏览器调用一致。
- Browser API：`src/lib/api.ts` 暴露 `getShopUploadQuota(shopId)`，实际发送命令 `get_shop_upload_quota` 和 `{ shopId }`。
- Shared return type：前端 `OzonUploadQuota` 字段与 Rust `#[serde(rename_all = camelCase)]` 输出一致，并保留 `operationLimits?: unknown`。
- 结论：三端调用路径和返回类型一致。

## Focused Test Evidence

### Rust quota tests

Command:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml product_upload_quota
```

Result:

- Exit code: `0`
- `3 passed; 0 failed`
- Covered parser fixture/remaining values, `operation_limits`, saturating subtraction, missing/non-numeric/negative required values。
- 仅出现既有 `local_mockup.rs::read_progress` dead-code warning，与 Task 4 无关。

### Command parity test

Command:

```powershell
npm test -- src/lib/localAssistantCommandParity.test.ts
```

Result:

- Exit code: `0`
- Test files: `1 passed`
- Tests: `1 passed`
- 本次聚焦命令未加载或受并行 Task 6 测试语法错误影响。

## Non-blocking Observation

- `localAssistantCommandParity.test.ts` 当前自动验证的是“所有 Tauri 注册命令均存在 local assistant 分派”；它没有解析 `src/lib/api.ts` 来自动验证浏览器 helper 映射。当前 Task 4 的 browser helper 已通过代码审查确认存在且参数一致，因此不构成阻断项。若后续希望让“三端 parity”完全由回归测试保护，可另行扩展该测试，但不要求为本次 Task 4 返工。

## Final Assessment

Task 4 按指定范围满足接口、严格解析、负数拒绝、饱和减法、未知操作限额保留以及 Tauri/local assistant/browser 调用一致性要求；指定聚焦测试均通过。结论：**APPROVED**。
