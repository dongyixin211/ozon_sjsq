# 飞书任务通知与活动保护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为本地助手增加用户级飞书任务通知、活动白名单清理和店铺正常卖价变动通知。

**Architecture:** 飞书 Webhook 与签名密钥只写入 Windows 安全存储，React 页面只读取脱敏状态。`JobRegistry` 通过异步通知通道统一发出任务开始与终态事件；本地 SQLite 保存价格快照；现有自动运维循环在允许活动集合之外清理商品并对卖价差异生成汇总。

**Tech Stack:** Tauri 2、Rust、Tokio、Reqwest、HMAC-SHA256、SQLite/Rusqlite、React、TypeScript、Vitest。

## Global Constraints

- 仅修改本地助手；不上传 Ozon 凭证、飞书 Webhook、飞书签名密钥或价格明细到云端。
- 保留每店现有 `maintenanceActionConfigs` 类目活动规则；不得收敛为单活动配置。
- 仅当店铺存在至少一个允许活动 ID 时执行自动清理。
- 飞书失败必须仅记录本地任务日志，绝不能改变任务执行结果。
- 首次观察到商品卖价时只建立快照；同轮多商品变价必须合并为一条飞书摘要。
- 不创建 Git 提交或分支，除非用户另行要求。

---

### Task 1: 飞书设置、安全存储与消息构造

**Files:**
- Create: `src-tauri/src/core/feishu.rs`
- Modify: `src-tauri/src/core/secrets.rs`
- Modify: `src-tauri/src/core/models.rs`
- Modify: `src-tauri/src/core/commands.rs`
- Modify: `src-tauri/src/core/local_assistant.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `packages/shared/src/types.ts`
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces `FeishuNotificationSettings { enabled, webhookConfigured, signingSecretConfigured }` and `FeishuNotificationDraft { enabled, webhook?, signingSecret? }`.
- Produces `feishu::build_task_message(event: &JobNotificationEvent) -> String` and `feishu::post_text(webhook: &str, signing_secret: Option<&str>, text: &str) -> Result<()>`.
- Produces Tauri/local-assistant commands `get_feishu_notification_settings`, `save_feishu_notification_settings`, and `test_feishu_notification`.

- [ ] **Step 1: Write the failing Rust tests**

```rust
#[test]
fn builds_signed_payload_without_exposing_the_secret() {
    let payload = build_text_payload(任务完成, Some((1_700_000_000, secret)));
    assert_eq!(payload[timestamp], 1700000000);
    assert!(payload[sign].as_str().is_some_and(|sign| !sign.contains(secret)));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml feishu::tests -- --nocapture`

Expected: compilation fails because `feishu` does not exist.

- [ ] **Step 3: Write the minimal secure configuration and sender**

```rust
pub const fn feishu_webhook_id() -> &'static str { ozon-sjsq-feishu-webhook }
pub async fn post_text(webhook: &str, signing_secret: Option<&str>, text: &str) -> Result<()> {
    let payload = build_text_payload(text, signing_secret.map(|secret| (Utc::now().timestamp(), secret)));
    reqwest::Client::new().post(webhook).json(&payload).send().await?.error_for_status()?;
    Ok(())
}
```

Store the enable flag in local settings and credential values through `secrets`. Empty credential input clears only that credential. The public response exposes only configured booleans; command handlers reject enabled configuration with no stored Webhook and are wired into both Tauri and local-assistant dispatch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml feishu::tests -- --nocapture`

Expected: all `feishu::tests` pass.

### Task 2: 在任务注册中心统一投递飞书通知

**Files:**
- Modify: `src-tauri/src/core/jobs.rs`
- Modify: `src-tauri/src/core/feishu.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/core/jobs.rs`

**Interfaces:**
- Consumes `FeishuNotificationSettings` and `feishu::post_text` from Task 1.
- Produces `JobNotificationEvent { phase: JobNotificationPhase, job: JobSummary }`.
- Produces `JobRegistry::set_notification_sender(UnboundedSender<JobNotificationEvent>)`.

- [ ] **Step 1: Write the failing lifecycle-event test**

```rust
#[test]
fn emits_started_then_terminal_events_once() {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let registry = JobRegistry::default();
    registry.set_notification_sender(sender);
    let job = registry.create_job(JobKind::Other, 导出.into(), None);
    registry.update(&job.id, JobStatus::Running, 10, None);
    registry.update(&job.id, JobStatus::Succeeded, 100, None);
    assert_eq!(receiver.try_recv().unwrap().phase, JobNotificationPhase::Started);
    assert_eq!(receiver.try_recv().unwrap().phase, JobNotificationPhase::Succeeded);
    assert!(receiver.try_recv().is_err());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml jobs::tests::emits_started_then_terminal_events_once -- --nocapture`

Expected: compilation fails because notification events and sender registration do not exist.

- [ ] **Step 3: Write the minimal lifecycle emission**

Define terminal handling for `Succeeded`, `PartialFailed`, `Failed`, and `Cancelled`. Emit `Started` after `create_job` persists the queued record, emit one terminal event only when state changes, and never emit progress events. In `lib.rs`, create the channel after `JobRegistry` initialization and spawn a receiver that loads local Feishu settings, calls `feishu::post_text`, and logs delivery errors without re-emitting events.

- [ ] **Step 4: Run focused task-registry tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml jobs::tests -- --nocapture`

Expected: lifecycle, cancellation, persistence, and existing job tests pass.

### Task 3: 本地价格快照与非授权活动清理

**Files:**
- Modify: `src-tauri/src/core/db.rs`
- Modify: `src-tauri/src/core/listing_maintenance.rs`
- Modify: `src-tauri/src/core/commands.rs`
- Test: `src-tauri/src/core/db.rs`
- Test: `src-tauri/src/core/listing_maintenance.rs`

**Interfaces:**
- Produces `Db::load_price_snapshots(shop_id: &str) -> Result<HashMap<i64, String>>` and `Db::replace_price_snapshots(shop_id: &str, prices: &HashMap<i64, String>) -> Result<()>` backed by `shop_product_price_snapshots`.
- Produces `unmanaged_action_ids(actions: &[Value], allowed: &HashSet<i64>) -> Vec<i64>` and `price_changes(previous: &HashMap<i64, String>, current: &HashMap<i64, ProductPrice>) -> Vec<PriceChange>`.
- Extends `run_listing_maintenance` to accept `Arc<Mutex<Db>>` for snapshot persistence.

- [ ] **Step 1: Write the failing policy tests**

```rust
#[test]
fn preserves_configured_actions_and_selects_only_unmanaged_actions() {
    let actions = vec![json!({id: 11}), json!({id: 22}), json!({id: 33})];
    assert_eq!(unmanaged_action_ids(&actions, &HashSet::from([11, 33])), vec![22]);
}

#[test]
fn first_price_snapshot_has_no_alert_but_later_change_does() {
    assert!(price_changes(&HashMap::new(), &HashMap::from([(7, product_price(8.00))])).is_empty());
    assert_eq!(price_changes(&HashMap::from([(7, 8.00.into())]), &HashMap::from([(7, product_price(7.50))])).len(), 1);
}
```

- [ ] **Step 2: Run the policy test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml listing_maintenance::tests::preserves_configured_actions_and_selects_only_unmanaged_actions -- --nocapture`

Expected: compilation fails because the policy helpers do not exist.

- [ ] **Step 3: Write snapshot persistence and maintenance steps**

Create the SQLite table with primary key `(shop_id, product_id)`. At each cycle collect allowed activity IDs from `request.action_configs`; if nonempty, page every unallowed activity using `action_products` and remove product IDs in existing `BATCH_SIZE` chunks. In the same cycle, use the existing price-enriched product listing path to compare normal `price` values, atomically replace store snapshots, and log one summary. Failure of cleanup or price checking must not suppress later eligible maintenance steps.

- [ ] **Step 4: Run maintenance and DB tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml listing_maintenance::tests db::tests -- --nocapture`

Expected: empty-rule safety, allowed-action preservation, first-snapshot, change detection, and existing DB tests pass.

### Task 4: 将活动清理与价格摘要接入飞书最终通知

**Files:**
- Modify: `src-tauri/src/core/models.rs`
- Modify: `src-tauri/src/core/jobs.rs`
- Modify: `src-tauri/src/core/listing_maintenance.rs`
- Modify: `src-tauri/src/core/feishu.rs`
- Test: `src-tauri/src/core/feishu.rs`

Test `build_task_message` with a cleanup/price summary; run it red, add the persisted optional summary and bounded detail formatter, then run `cargo test --manifest-path src-tauri/Cargo.toml feishu::tests jobs::tests` green.

### Task 5: 飞书设置页面

Add `SettingsPage.test.tsx` first; test masked inputs, save and test calls. Then add settings UI/API methods and run `npm test -- SettingsPage.test.tsx`.

### Task 6: 文档与验证

Document robot setup and empty-rule safety. Run targeted Rust/TypeScript tests, then `npm test`, `npm run build`, and `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`.
