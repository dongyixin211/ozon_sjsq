# Task 5 Report: Local Scheduler and Recovery

## Scope Completed

- Added a pure `decide_next_action` scheduler core with the `08:00–22:00` default window, date rollover, per-account tick exclusion, unknown-quota shop exclusion, active-batch protection, waiting-run execution, and checkpoint recovery decisions.
- Added `AutoListingScheduler` startup recovery, immediate startup tick, ten-minute periodic tick, and manual wake/run support.
- Reused the existing local mockup and `start_auto_listing` jobs. The scheduler processes only cloud-reserved assignments, calls the existing cached title endpoint (therefore only missing titles are generated), creates the existing cloud listing batch, then starts the existing automatic listing job.
- Prevented new reservations while an executing cloud run exists. Failed mockup/title items are marked failed independently and are not advanced to ready/submitting.
- Added manual `scheduler_status`, `run_auto_listing_plan_now`, and `pause_auto_listing_plan` commands to Tauri, local-assistant command parity, and `src/lib/api.ts`.

## RED

1. `cargo test --manifest-path src-tauri/Cargo.toml auto_listing_scheduler`
   - Failed because `SchedulerDecisionInput`, `ShopScheduleState`, `SchedulerAction`, `NoopReason`, and `decide_next_action` did not exist.
2. `cargo test --manifest-path src-tauri/Cargo.toml scheduler_checkpoint_roundtrip_preserves_recovery_progress`
   - Failed because `AutoListingSchedulerRecord` and the SQLite save/list methods did not exist.

## GREEN

- Scheduler decision tests: 6 passed.
- SQLite checkpoint roundtrip test: passed.
- Full Rust suite: 91 passed, 0 failed.
- Local assistant parity: 1 passed, 0 failed.
- Web TypeScript/Vite build: passed.

## Files

- Created `src-tauri/src/core/auto_listing_scheduler.rs`.
- Modified `src-tauri/src/core/mod.rs`.
- Modified `src-tauri/src/lib.rs`.
- Modified `src-tauri/src/core/commands.rs`.
- Modified `src-tauri/src/core/local_assistant.rs` for required browser parity.
- Modified `src/lib/api.ts`.
- Modified `src-tauri/src/core/db.rs` for minimal scheduler persistence.

## SQLite Persistence

Added one table: `auto_listing_scheduler_state`.

It stores account/plan identity, cloud base URL, a keyring/fallback secret reference (not the raw token), pause state, quota date, cloud run ID, local job ID, current stage, pending progress payload, last error, and update timestamp. Pending progress is saved before cloud upload and cleared only after acknowledgement.

## Recovery Behavior

- Closing the client naturally pauses the local loop.
- Startup restores registered account sessions from secret references and ticks immediately.
- A preparing checkpoint reruns only its reserved assignments; cloud mockup results and title generation are idempotent/cached by source asset.
- A submitting checkpoint inspects the persisted local job. Completed jobs flush assignment completion; interrupted/cancelled jobs rebuild the request from the existing cloud listing batch and reuse `start_auto_listing`.

## Validation Commands

```powershell
cargo test --manifest-path src-tauri/Cargo.toml auto_listing_scheduler
cargo test --manifest-path src-tauri/Cargo.toml scheduler_checkpoint_roundtrip_preserves_recovery_progress
cargo test --manifest-path src-tauri/Cargo.toml
npm test -- src/lib/localAssistantCommandParity.test.ts
npm run build:web
```

## Limitations

- No live authenticated cloud/Ozon end-to-end run was performed in this task; validation is unit/build/parity based.
- An account session is persisted when `run_auto_listing_plan_now` is called. After that first registration, startup recovery and periodic ticks are automatic. A future UI task should ensure the first manual run/configuration flow invokes this command with the current account ID and cloud token.
- Existing repository warning remains: `local_mockup::read_progress` is unused.
- Repository-wide `cargo fmt --check` also reports a pre-existing formatting difference in `src-tauri/src/core/order_docs.rs`; only Task 5 Rust files were formatted to avoid changing unrelated shared work.
