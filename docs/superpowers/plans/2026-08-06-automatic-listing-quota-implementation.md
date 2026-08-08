# Automatic Listing Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic listing target 100 successful Ozon submissions per configured shop per day, with automatic unused-image selection, continuous refill, bounded concurrency, retries, and per-shop progress.

**Architecture:** Keep cloud PostgreSQL as the source of truth for daily assignments and usage, extend the reservation API to accept a per-shop daily target and reserve only each shop's remaining capacity, then let the Rust scheduler repeatedly refill and submit batches until the target or eligible asset pool is exhausted. Keep mockup rendering and title generation in the existing pipeline, and add tests around pure planning and scheduler decisions before changing runtime behavior.

**Tech Stack:** TypeScript/Fastify/PostgreSQL, Rust/Tauri/Tokio, Vitest, Rust unit tests.

## Global Constraints

- Daily target is 100 successful submissions per configured shop; 12 shops represent 1200 planned submissions/day.
- Do not require manual image selection for an enabled automatic listing plan.
- Preserve transactional asset reservation and existing per-shop product/mockup template snapshots.
- Treat one-hour completion as a submission/progress target; final Ozon publication remains asynchronous.
- Do not change inventory, barcode, action, or unrelated listing workflows.

---

### Task 1: Define quota and refill planning behavior

**Files:**
- Modify: `server/src/auto-listing-planner.ts`
- Test: `server/src/auto-listing-planner.test.ts`
- Modify: `packages/shared/src/types.ts` only if the new target field is required by shared API types

**Interfaces:**
- Add pure planning functions for per-shop daily remaining target and safe capacity.
- Preserve `allocateRoundRobin` as the deterministic tie-break allocator.

- [ ] Write failing tests for a shop with daily target 100, zero usage, and zero outstanding assignments producing 100 capacity; for 40 completed and 10 active producing 50; and for a shop whose live Ozon quota is lower than its target receiving only the live remaining amount.
- [ ] Run `server` planner tests and verify the new tests fail against the current 5% reserve behavior.
- [ ] Implement the smallest pure-function change that makes daily target and configurable safety reserve explicit, defaulting the requested automatic plan to zero reserve.
- [ ] Add a test that allocations never exceed per-shop target capacity and remain balanced when capacities tie.
- [ ] Run the focused planner tests and confirm they pass.

### Task 2: Make cloud reservations refill by daily shop target

**Files:**
- Modify: `server/src/routes/gallery-auto-listing-routes.ts:248-306`
- Modify: `server/src/auto-listing-reservation.ts:70-101`
- Test: `server/src/auto-listing-reservation.test.ts`
- Modify: `packages/shared/src/types.ts` and `src/lib/cloudApi.ts` if request/response types need the target fields

**Interfaces:**
- Reservation input carries the plan daily target and current per-shop successful usage/active assignments.
- Reservation response continues returning a run and assignments so the Rust scheduler remains compatible.

- [ ] Write failing tests proving reservation capacity is calculated per shop as `target - successful today - active assignments`, not as one global `batchSize + bufferSize` pool.
- [ ] Write a failing test proving an asset is excluded when it is already used, mockup-rendered, assigned, or in a listing batch.
- [ ] Run the focused reservation tests and verify failure.
- [ ] Implement a transactionally consistent daily usage query and per-shop capacity calculation; cap each shop by the live Ozon quota and avoid reserving beyond the requested batch window per refill.
- [ ] Keep empty reservations recoverable and return a structured reason/count so the scheduler can distinguish no assets from quota exhaustion.
- [ ] Run reservation tests and the TypeScript type check.

### Task 3: Remove manual-selection dependency from automatic plans

**Files:**
- Modify: `src-tauri/src/core/auto_listing_scheduler.rs:556-787`
- Modify: `src-tauri/src/core/auto_listing_scheduler.rs:1214-1232`
- Test: `src-tauri/src/core/auto_listing_scheduler.rs` unit tests

**Interfaces:**
- Scheduler fetches eligible assignments from the reservation API and builds the existing `AutoListingRequest` from assignments; no UI-selected asset IDs are read.
- Existing mockup, title, batch creation, and checkpoint calls remain the execution pipeline.

- [ ] Add failing Rust tests for a scheduled tick with no UI selection that still reserves a batch when eligible shops and assets exist.
- [ ] Add a failing test for a completed run followed by a refill tick that requests another batch while the shop remains below 100.
- [ ] Run focused Rust tests and verify failure.
- [ ] Implement scheduled refill decisions that continue after terminal runs and clear only terminal checkpoint state; keep active work recovery ahead of the execution window.
- [ ] Make the no-assets outcome a normal exhausted state with a visible scheduler status rather than a manual-selection error.
- [ ] Run focused scheduler tests.

### Task 4: Add bounded concurrent submission and retry policy

**Files:**
- Modify: `src-tauri/src/core/auto_listing.rs:81-696`
- Modify: `src-tauri/src/core/auto_listing_scheduler.rs:996-1085`
- Test: existing Rust auto-listing tests plus new focused tests near retry helpers

**Interfaces:**
- Keep `commands::start_auto_listing` and `AutoListingRequest` public shapes stable.
- Add bounded concurrency at shop/batch worker boundaries and classify retryable versus permanent failures.

- [ ] Add failing tests for retryable network/image/Ozon throttling errors and permanent template/validation errors.
- [ ] Add a failing test proving a successful assignment is not submitted again after scheduler restart.
- [ ] Implement bounded concurrency with a fixed maximum suitable for 12 shops, exponential backoff with a finite retry count, and persisted assignment progress after each state transition.
- [ ] Reuse successful mockup results and completed listing-batch image sets during recovery.
- [ ] Keep failures isolated per shop so one shop does not stop the remaining shops.
- [ ] Run focused Rust tests.

### Task 5: Expose per-shop daily progress and diagnostics

**Files:**
- Modify: `src/features/cloud/AutoListingPlansPage.tsx`
- Modify: `src/lib/api.ts` and/or `src/lib/cloudApi.ts` only where status types require it
- Test: `src/features/cloud/AutoListingPlansPage.test.tsx` or the nearest existing auto-listing page test

**Interfaces:**
- Scheduler status displays target, successful, active, failed, remaining, and exhaustion reason per shop.
- Existing plan fields remain editable; add only the requested daily target/safety setting if not fixed to 100.

- [ ] Add failing UI tests for 12 shops showing independent remaining counts and for an exhausted image pool showing a clear reason.
- [ ] Implement the smallest status response/UI change needed to expose per-shop progress and one-hour progress warnings.
- [ ] Run the focused UI tests.

### Task 6: Verify end-to-end behavior and update documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-automatic-listing-quota-design.md` if implementation decisions change
- Modify: relevant project documentation only if user-facing setup steps change

- [ ] Run all server tests, frontend tests, TypeScript checks, and Rust checks available in the repository.
- [ ] Run the existing automatic-listing consistency smoke test when the configured database is available; otherwise record the database prerequisite without changing production data.
- [ ] Verify the diff is limited to automatic listing, quota, scheduler, diagnostics, tests, and docs.
- [ ] Report exact achieved guarantees and external Ozon limitations.
