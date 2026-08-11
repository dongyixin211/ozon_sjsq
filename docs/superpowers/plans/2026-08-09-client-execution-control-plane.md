# Client-Controlled Local Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Convert every eligible heavy or external side-effecting workflow to a web-controlled, Rust-client-executed task while the server remains the authenticated control plane and source of truth.

**Architecture:** The web UI creates control-plane tasks only after the account's single bound device is online. The server persists state, enforces idempotency, exposes task and monitoring data, and supplies versioned AI/OSS configuration. The Tauri/Rust client long-polls for work, executes file/AI/OSS/Ozon operations locally, stores detailed logs and unsent events locally, and writes idempotent summaries back through authenticated APIs.

**Tech Stack:** Fastify, TypeScript, PostgreSQL, React 18, Vite, Tauri 2, Rust, reqwest, SQLite, OSS-compatible storage, Ozon Seller API, AI provider APIs.

## Global Constraints

- One account binds to one execution client. Reject task creation when the latest heartbeat is older than 90 seconds.
- Client heartbeat is 30 seconds; client claims work through a 25-second HTTPS long-poll; web task pages poll status every 3 seconds. Do not add WebSocket or SSE.
- Rust owns execution, external calls, local file I/O, retries, Outbox, and detailed logs. React only controls and displays.
- Server PostgreSQL is the only source of truth. Clients never connect directly to PostgreSQL; every result uses authenticated, idempotent API writes.
- Client configuration is versioned by the server, encrypted locally, synchronized at startup and heartbeat, and invalidated when revoked.
- Old clients must update when below the server-configured minimum version. Do not keep old-protocol paths.
- Use task references/object keys, never file bytes, in control-plane bodies.
- Users have one active top-level task. Listing stores run in parallel; products in a store run in order. Per-product failure does not stop its store.
- Retry only retryable external failures three times with 5s, 20s, and 60s backoff. Never automatically retry unknown Ozon outcomes.
- Keep client Outbox events seven days. Keep metrics 90 days, error summaries 30 days, detailed errors 7 days.
- Record AI usage and estimated cost only; do not enforce AI quotas.
- Delete only explicitly temporary OSS objects 30 minutes after confirmed product upload success.
- Local acceptance uses account \`18338062216\`, real AI/OSS/Ozon writes, and production data. It may use production PostgreSQL only with backup, account restriction, \`local_test\` marking, audit, and no-release safeguards.
- Production-database migrations during local acceptance are additive and backward-compatible only. Do not drop schema or bulk rewrite business data.
- Do not publish production code or enable the new production path until separately requested.

---

## File Structure

| File | Responsibility |
| --- | --- |
| \`server/migrations/042_client_execution_control_plane.sql\` | Add client devices, tasks, per-store/items, events, AI usage, metrics, errors, temporary-object cleanup, and local-test audit schema. |
| \`server/src/client-task-contract.ts\` | Define Zod-validated task types, states, events, operation IDs, capabilities, and retry classification. |
| \`server/src/client-task-service.ts\` | Create, claim, lease, cancel, report, and clean up client tasks transactionally. |
| \`server/src/client-task-monitoring.ts\` | Persist redacted operation metrics/errors and run retention cleanup. |
| \`server/src/routes/client-task-routes.ts\` | Expose user-device control APIs and administrator read APIs. |
| \`server/src/routes/auth-routes.ts\`, \`server/src/feature-service.ts\`, \`server/src/app.ts\`, \`server/src/config.ts\` | Extend device heartbeat, version/capabilities/config delivery, route registration, safeguards, and fallback configuration. |
| \`src-tauri/src/core/client_task_protocol.rs\` | Rust task/event/capability contract matching TypeScript names. |
| \`src-tauri/src/core/client_task_executor.rs\` | Heartbeat, long-poll claim, lease renewal, scheduling, cancellation, reporting, and resume. |
| \`src-tauri/src/core/client_task_outbox.rs\` | Durable unsent events, retry schedule, acknowledgement, expiry, and manual-attention state. |
| \`src-tauri/src/core/ai.rs\`, \`oss.rs\`, \`gallery_upload.rs\`, \`local_mockup.rs\`, \`order_docs.rs\`, \`auto_listing.rs\`, \`listing_maintenance.rs\`, \`product_catalog.rs\` | Existing local implementations reused as typed task handlers. |
| \`src/lib/cloudApi.ts\`, \`src/features/jobs/JobsPage.tsx\`, \`src/App.tsx\` | Web task creation, polling, progress, cancellation, and device status UI. |
| \`server/src/public/admin.html\` | Chinese admin UI for devices, monitoring, errors, AI cost, cleanup, local tests, and fallback audit. |
| \`docs/client-execution/*.md\` | Migration matrix, architecture/protocol, test report, and operations runbook. |

## Task 1: Define the migration matrix and cross-runtime task contract

**Files:**
- Create: \`docs/client-execution/feature-migration-matrix.md\`
- Create: \`server/src/client-task-contract.ts\`
- Test: \`server/src/client-task-contract.test.ts\`

**Interfaces:** Export \`ClientTaskType\`, \`ClientTaskState\`, \`ClientTaskCreateInput\`, \`ClientTaskEventInput\`, \`ClientCapabilityReport\`, and \`isRetryableExternalFailure\`.

- [ ] **Step 1: Write the failing contract test**

\`\`\`ts
assert.equal(parseTaskCreate({ type: "listing.local_excel", operationId: "op-1" }).type, "listing.local_excel");
assert.throws(() => parseTaskCreate({ type: "unknown", operationId: "op-1" }), /task type/i);
assert.equal(isRetryableExternalFailure({ status: 429 }), true);
assert.equal(isRetryableExternalFailure({ status: 400 }), false);
assert.equal(isRetryableExternalFailure({ outcome: "unknown" }), false);
\`\`\`

- [ ] **Step 2: Run it and confirm it fails**

Run: \`npm test -- client-task-contract.test.ts\`

Expected: the contract module is missing.

- [ ] **Step 3: Implement the contract**

\`\`\`ts
export const clientTaskTypes = [
  "image.download", "image.transform", "ai.image_generation", "ai.title_generation",
  "mockup.render", "oss.upload", "oss.cleanup", "orders.download",
  "listing.local_excel", "listing.maintenance", "product.catalog.sync",
] as const;
export const clientTaskStates = [
  "created", "claimed", "running", "partial_success", "succeeded", "failed",
  "cancel_requested", "cancelled", "interrupted", "unknown_outcome", "manual_attention",
] as const;
\`\`\`

Validate task references, store IDs, configuration versions, \`operationId\`, and \`localTest\`; reject file binary fields and unknown state values.

- [ ] **Step 4: Write the migration matrix**

Map every user action from \`ai-routes.ts\`, \`gallery-routes.ts\`, \`mockup-routes.ts\`, \`order-routes.ts\`, \`gallery-auto-listing-routes.ts\`, \`legacy-listing-upload-routes.ts\`, \`product-catalog-routes.ts\`, and the existing Tauri commands. Mark authentication, authorization, configuration, metadata persistence, task control, administrator functions, and database access as server-resident.

- [ ] **Step 5: Verify and commit**

Run: \`npm test -- client-task-contract.test.ts\`

\`\`\`bash
git add server/src/client-task-contract.ts server/src/client-task-contract.test.ts docs/client-execution/feature-migration-matrix.md
git commit -m "feat: define client execution task contracts"
\`\`\`

## Task 2: Add the additive control-plane schema and safeguards

**Files:**
- Create: \`server/migrations/042_client_execution_control_plane.sql\`
- Modify: \`server/src/config.ts\`
- Test: \`server/src/client-task-schema.test.ts\`

**Interfaces:** Add \`client_devices\`, \`client_tasks\`, \`client_task_stores\`, \`client_task_items\`, \`client_task_events\`, \`client_task_operations\`, \`client_ai_usage\`, \`client_operation_metrics\`, \`client_operation_errors\`, \`client_temporary_objects\`, and \`client_local_test_audit\`.

- [ ] **Step 1: Write the failing migration test**

\`\`\`ts
const sql = readSource("../migrations/042_client_execution_control_plane.sql");
assert.match(sql, /CREATE TABLE IF NOT EXISTS client_tasks/);
assert.match(sql, /operation_id.*UNIQUE/i);
assert.match(sql, /local_test.*BOOLEAN/i);
assert.doesNotMatch(sql, /DROP\\s+TABLE|DROP\\s+COLUMN|DELETE\\s+FROM/i);
\`\`\`

- [ ] **Step 2: Implement the migration and config**

Use foreign keys to existing users/devices. Persist \`lease_expires_at\`, \`claimed_by_device_id\`, \`capability\`, \`config_version\`, \`local_test\`, \`source\`, and \`operation_id\`. Add these safe indexes:

\`\`\`sql
CREATE UNIQUE INDEX IF NOT EXISTS client_tasks_active_user_idx
  ON client_tasks (user_id)
  WHERE state IN ('created', 'claimed', 'running', 'cancel_requested');
CREATE UNIQUE INDEX IF NOT EXISTS client_task_operations_unique_idx
  ON client_task_operations (user_id, operation_id);
CREATE INDEX IF NOT EXISTS client_devices_online_idx
  ON client_devices (user_id, last_heartbeat_at DESC)
  WHERE revoked_at IS NULL;
\`\`\`

Add validated settings for minimum version, 30-second heartbeat, 90-second offline threshold, leases, retention windows, fallback, and local-test guard fields.

- [ ] **Step 3: Verify and commit**

Run: \`npm test -- client-task-schema.test.ts\`

Run: \`npm run migrate\` from \`server\` against the local test database.

\`\`\`bash
git add server/migrations/042_client_execution_control_plane.sql server/src/config.ts server/src/client-task-schema.test.ts
git commit -m "feat: add client task control plane schema"
\`\`\`

## Task 3: Implement device, task, config, monitoring, and cleanup APIs

**Files:**
- Create: \`server/src/client-task-service.ts\`
- Create: \`server/src/client-task-monitoring.ts\`
- Create: \`server/src/routes/client-task-routes.ts\`
- Modify: \`server/src/routes/auth-routes.ts\`, \`server/src/feature-service.ts\`, \`server/src/app.ts\`
- Test: \`server/src/client-task-routes.test.ts\`

**Interfaces:**
- \`POST /client/heartbeat\` accepts version/capabilities/config version.
- \`POST /client/tasks/claim\` long-polls at most 25 seconds.
- \`POST /client/tasks/:taskId/events\` accepts idempotent state, progress, metric, usage, and cleanup events.
- \`GET /client/tasks\` serves the current user's web polling.
- \`POST /client/tasks/:taskId/cancel\` requests safe cancellation.
- \`GET /client/config\` returns only the bound user's versioned AI/OSS payload.

- [ ] **Step 1: Write failing ownership and online tests**

\`\`\`ts
assert.equal(await createTaskForUser(offlineUser), "CLIENT_OFFLINE");
assert.equal(await createTaskForUser(onlineUser), "created");
assert.equal(await claimTask(otherDevice), null);
assert.equal(await claimTask(oldClient), "CLIENT_UPDATE_REQUIRED");
assert.equal(await createTaskForOtherUser(adminUser), "FORBIDDEN");
\`\`\`

- [ ] **Step 2: Implement transaction/lease rules**

Create/claim/cancel within a transaction. Reject creation unless the bound client heartbeated within 90 seconds and declares the task capability. Claim using \`SELECT ... FOR UPDATE SKIP LOCKED\`, issue a 60-second lease, and enforce \`(user_id, operation_id)\` idempotency.

- [ ] **Step 3: Implement local-test and monitoring safeguards**

When local-test mode is enabled, require phone \`18338062216\`, force \`local_test=true\`, write an audit event, and reject all other users. Redact/truncate errors, never log secret values, record logical operation names only, and schedule 90/30/7-day retention cleanup.

- [ ] **Step 4: Verify and commit**

Run: \`npm test -- client-task-routes.test.ts admin-auth.test.ts\`

Run: \`npm run check\` from \`server\`.

\`\`\`bash
git add server/src/client-task-service.ts server/src/client-task-monitoring.ts server/src/routes/client-task-routes.ts server/src/routes/auth-routes.ts server/src/feature-service.ts server/src/app.ts server/src/client-task-routes.test.ts
git commit -m "feat: add client task control APIs"
\`\`\`

## Task 4: Add the durable Rust executor and Outbox

**Files:**
- Create: \`src-tauri/src/core/client_task_protocol.rs\`
- Create: \`src-tauri/src/core/client_task_executor.rs\`
- Create: \`src-tauri/src/core/client_task_outbox.rs\`
- Modify: \`src-tauri/src/core/cloud_bridge.rs\`, \`src-tauri/src/core/secrets.rs\`, \`src-tauri/src/core/jobs.rs\`, \`src-tauri/src/core/mod.rs\`, \`src-tauri/src/lib.rs\`
- Test: module unit tests

**Interfaces:** \`ClientTaskExecutor::start(app)\`, \`ClientTaskOutbox::enqueue(event)\`, \`ClientTaskOutbox::flush()\`, and \`execute_task(task)\`.

- [ ] **Step 1: Write failing Rust tests**

\`\`\`rust
#[test]
fn unknown_outcome_is_not_retryable() {
    assert!(!RetryClass::from_status(Some(0), true).is_retryable());
}
#[test]
fn outbox_keeps_unsent_events_for_seven_days() {
    let outbox = TestOutbox::new();
    outbox.enqueue(event("evt-1"));
    assert_eq!(outbox.pending().len(), 1);
}
\`\`\`

- [ ] **Step 2: Implement protocol and durable storage**

Mirror TypeScript values exactly using serde camelCase. Persist server task IDs, store/item cursors, operation IDs, retry counters, next-attempt timestamp, acknowledgement IDs, and manual-attention state in the existing local SQLite boundary.

- [ ] **Step 3: Implement lifecycle**

In Tauri only, heartbeat every 30 seconds; halt business work when minimum version is unmet; long-poll claim for 25 seconds; renew leases while running; stop claiming on cancellation or tray exit; use 5/20/60 second retry then capped backoff; preserve unsent results for 7 days.

- [ ] **Step 4: Verify and commit**

Run: \`cargo test\` and \`cargo check\` from \`src-tauri\`.

\`\`\`bash
git add src-tauri/src/core/client_task_protocol.rs src-tauri/src/core/client_task_executor.rs src-tauri/src/core/client_task_outbox.rs src-tauri/src/core/cloud_bridge.rs src-tauri/src/core/secrets.rs src-tauri/src/core/jobs.rs src-tauri/src/core/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add durable client task executor"
\`\`\`

## Task 5: Reuse local modules as client task handlers

**Files:**
- Modify: \`src-tauri/src/core/ai.rs\`, \`oss.rs\`, \`gallery_upload.rs\`, \`local_mockup.rs\`, \`order_docs.rs\`, \`auto_listing.rs\`, \`listing_maintenance.rs\`, \`product_catalog.rs\`, \`commands.rs\`
- Test: handler and scheduler tests alongside each module

**Interfaces:** Every handler receives a claimed task and emits start, progress, result, error, metric, AI usage, and cleanup events through the Outbox.

- [ ] **Step 1: Write failing dispatch tests**

\`\`\`rust
#[tokio::test]
async fn image_generation_task_calls_ai_handler() {
    let event = execute_with_fake_services(task("ai.image_generation")).await?;
    assert_eq!(event.state, ClientTaskState::Succeeded);
}
#[tokio::test]
async fn listing_runs_stores_in_parallel_and_items_in_order() {
    let trace = execute_listing_with_fake_ozon(two_store_task()).await?;
    assert!(trace.stores_overlap());
    assert!(trace.items_are_ordered_per_store());
}
\`\`\`

- [ ] **Step 2: Implement image/AI/OSS/mockup/order/catalog handlers**

Map \`image.download\`, \`image.transform\`, \`ai.image_generation\`, \`ai.title_generation\`, \`mockup.render\`, \`oss.upload\`, \`oss.cleanup\`, \`orders.download\`, and \`product.catalog.sync\` to existing Rust code. Send references only, not file bytes.

- [ ] **Step 3: Implement listing semantics**

Map \`listing.local_excel\` and \`listing.maintenance\` to existing listing functions. Run stores concurrently under the adaptive scheduler, process items in each store in Excel order, continue after failures, pause only rate-limited stores, and record unknown external outcomes without retry.

- [ ] **Step 4: Implement temporary OSS cleanup**

After confirmed product upload success, enqueue an object with \`cleanup_at = success_at + 30 minutes\`. Delete only objects explicitly marked temporary. On failure, retain and retry after the client next runs.

- [ ] **Step 5: Verify and commit**

Run: \`cargo test\` from \`src-tauri\`.

\`\`\`bash
git add src-tauri/src/core
git commit -m "feat: execute business workflows on client"
\`\`\`

## Task 6: Switch web controls and add administrator observability

**Files:**
- Modify: \`src/lib/cloudApi.ts\`, \`src/features/jobs/JobsPage.tsx\`, \`src/features/orders/OrdersPage.tsx\`, \`src/features/cloud/AutoListingPlansPage.tsx\`, affected material/mockup pages, \`src/App.tsx\`
- Modify: \`server/src/public/admin.html\`
- Test: existing React page tests and \`server/src/admin-auth.test.ts\`

**Interfaces:** Add web client methods \`createClientTask\`, \`listClientTasks\`, \`cancelClientTask\`, \`retryClientTask\`, and \`getClientDeviceStatus\`.

- [ ] **Step 1: Write failing UI tests**

\`\`\`tsx
expect(await screen.findByText("本地客户端离线，暂不能提交任务")).toBeVisible();
expect(createTask).not.toHaveBeenCalled();
expect(await screen.findByText("当前已有任务正在执行")).toBeVisible();
\`\`\`

- [ ] **Step 2: Replace direct server execution with task creation**

Every eligible page submits a reference-based client task and navigates to task status. Poll current-user task state every three seconds only while the task view is active; stop timers on unmount/logout/no active task.

- [ ] **Step 3: Add Chinese admin pages**

Show client online/version/capabilities, P95/P99 and error rate by logical operation, recent redacted errors, AI usage/cost, temporary-object cleanup status, \`local_test\` source, and audited fallback changes. Never show secrets or complete request bodies.

- [ ] **Step 4: Verify and commit**

Run: \`npm test -- JobsPage.test.tsx OrdersPage.test.tsx WorkspaceModuleTabs.test.tsx\`

Run: \`npm test\` from \`server\`.

\`\`\`bash
git add src/lib/cloudApi.ts src/features src/App.tsx server/src/public/admin.html
git commit -m "feat: control local client tasks from web"
\`\`\`

## Task 7: Gate old server execution behind audited emergency fallback

**Files:**
- Modify: \`server/src/routes/ai-routes.ts\`, \`gallery-routes.ts\`, \`mockup-routes.ts\`, \`order-routes.ts\`, \`gallery-auto-listing-routes.ts\`, \`legacy-listing-upload-routes.ts\`, \`product-catalog-routes.ts\`, \`admin-routes.ts\`
- Test: \`server/src/client-task-routes.test.ts\`, \`server/src/admin-auth.test.ts\`

**Interfaces:** \`assertServerExecutionFallbackEnabled(request, operation)\` rejects eligible heavy routes unless a password-authenticated administrator enabled the audited emergency switch.

- [ ] **Step 1: Write failing gate tests**

\`\`\`ts
await assert.rejects(callHeavyRoute({ fallback: false }), /CLIENT_EXECUTION_REQUIRED/);
assert.equal(await callHeavyRoute({ fallback: true, adminApproved: true }).statusCode, 200);
assert.equal(await nonAdminToggleFallback(), "FORBIDDEN");
\`\`\`

- [ ] **Step 2: Implement one shared gate and add it to every eligible heavy route**

Keep metadata/read-only endpoints available. Do not remove old execution code in this release. Every fallback change writes administrator audit data and, in local mode, a \`local_test\` audit row.

- [ ] **Step 3: Verify and commit**

Run: \`npm test\` and \`npm run check\` from \`server\`.

\`\`\`bash
git add server/src/routes server/src/client-task-service.ts server/src/admin-auth.test.ts
git commit -m "feat: gate server execution behind emergency fallback"
\`\`\`

## Task 8: Create guarded local-test tooling and 100-client test harness

**Files:**
- Create: \`scripts/prepare-local-client-execution-test.ps1\`
- Create: \`scripts/verify-production-backup.ps1\`
- Create: \`server/scripts/client-task-load-test.ts\`
- Create: \`server/scripts/client-task-fault-injection.ts\`
- Create: \`server/src/client-task-load.test.ts\`
- Modify: \`server/package.json\`, \`server/.env.local.example\`, \`server/README.md\`

**Interfaces:** Preflight requires local-test mode, allowed phone \`18338062216\`, explicit production connection, and fresh backup marker. Load simulator uses 100 virtual devices and mock external APIs.

- [ ] **Step 1: Write failing guard and simulator tests**

\`\`\`powershell
Invoke-ClientExecutionPreflight -LocalTestMode $false | Should -Throw
Invoke-ClientExecutionPreflight -AllowedPhone 'other-user' | Should -Throw
Invoke-ClientExecutionPreflight -BackupTimestamp $expiredTimestamp | Should -Throw
\`\`\`

\`\`\`ts
const result = await runVirtualClients({ clients: 100, durationSeconds: 30, externalMode: "mock" });
assert.equal(result.duplicateClaims, 0);
assert.equal(result.dbPoolErrors, 0);
assert.ok(result.taskCreate.p95Ms < 1000);
assert.ok(result.heartbeat.p95Ms < 300);
\`\`\`

- [ ] **Step 2: Implement safeguards and test modes**

Require a production-backup marker newer than 30 minutes, mask all secrets in output, force the allowed phone and \`local_test\` source, and refuse startup if safeguards are absent. Simulate Ozon/AI/OSS, server restart, DB outage, client crash, Outbox recovery, cleanup failure, forced update, and 100-client reconnect burst.

- [ ] **Step 3: Execute 30-minute local load/fault tests**

Run: \`npm run client-tasks:load -- --clients 100 --duration-minutes 30 --external-mode mock\`

Run: \`npm run client-tasks:fault-injection\`

Expected: task creation P95 < 1s, status P95 < 500ms, heartbeat P95 < 300ms, claim/progress P95 < 1s, error rate < 0.5%, no duplicate claims, no DB pool exhaustion.

- [ ] **Step 4: Commit tooling**

\`\`\`bash
git add scripts/prepare-local-client-execution-test.ps1 scripts/verify-production-backup.ps1 server/scripts/client-task-load-test.ts server/scripts/client-task-fault-injection.ts server/src/client-task-load.test.ts server/package.json server/.env.local.example server/README.md
git commit -m "test: add guarded client execution load tests"
\`\`\`

## Task 9: Complete local acceptance, records, and no-release handoff

**Files:**
- Create: \`docs/change-log/2026-08-09-client-execution-control-plane.md\`
- Create: \`docs/client-execution/architecture-and-protocol.md\`
- Create: \`docs/client-execution/local-acceptance-and-load-test.md\`
- Create: \`docs/client-execution/operations-runbook.md\`
- Modify: \`docs/client-execution/feature-migration-matrix.md\`

- [ ] **Step 1: Record the exact protocol and operations manual**

Document task states, operation IDs, ownership, heartbeat/offline rules, long-poll, config rotation, retry/cancellation semantics, per-store scheduling, Outbox recovery, monitoring retention, AI record fields, OSS cleanup rules, forced update, local-test safeguards, and emergency fallback.

- [ ] **Step 2: Execute real local acceptance under safeguards**

Use only \`18338062216\`. Run a small real AI request, one temporary OSS cleanup, one local folder/Excel listing, one order workflow, one mockup render, cancellation, retry, and result sync. Verify every generated record is \`local_test=true\` and no secret appears in logs or docs.

- [ ] **Step 3: Run complete validation**

Run: \`npm test\`

Run: \`npm run build\`

Run: \`npm run build:web\`

Run: \`npm test\` and \`npm run check\` from \`server\`

Run: \`cargo test\` and \`cargo check\` from \`src-tauri\`

- [ ] **Step 4: Perform no-release review and commit records**

Verify no production application was deployed/restarted, emergency fallback remains disabled, local production-DB connection is closed when testing ends, and every eligible operation in the matrix is verified.

\`\`\`bash
git add docs/change-log/2026-08-09-client-execution-control-plane.md docs/client-execution
git commit -m "docs: record client execution local acceptance"
\`\`\`

## Self-Review

- **Spec coverage:** Tasks 1–9 cover the agreed client execution scope, web control, single-device ownership, heartbeat/long-poll, capability/version enforcement, local execution, server truth, metrics/errors, AI records, temporary OSS cleanup, retry/cancel semantics, parallel stores/sequential store items, local production-data testing safeguards, additive migrations, 100-client load/fault tests, documents, and no-release requirement.
- **Placeholder scan:** Each task names exact files, commands, interfaces, tests, and resulting behavior. No implementation task depends on an unrecorded product decision.
- **Type consistency:** Task type/state names are defined in Task 1 and used unchanged by all later tasks. All result writes use task ID plus operation ID. Local-test writes use \`local_test\` consistently.

## Execution Handoff

Plan complete and saved to \`docs/superpowers/plans/2026-08-09-client-execution-control-plane.md\`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — Execute tasks in this session using \`executing-plans\`, with checkpoints.

Neither option publishes production. Local implementation must pass the documented safeguards before it connects to production PostgreSQL.
