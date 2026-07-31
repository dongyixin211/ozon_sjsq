# Task 3 Report: Cloud Plan and Reservation API

Date: 2026-07-28

## Scope completed

- Added focused Fastify routes for automatic-listing plan CRUD, atomic reservations, assignment progress, guarded release, and run listing.
- Registered the focused route module from `gallery-routes.ts` with the existing Fastify plugin pattern.
- Added typed browser client methods for plan CRUD, reservations, progress updates, releases, and run queries.
- Extended planner tests and pure guards for plan validation, assignment transitions, reservation capacity, release eligibility, and immutable batch binding.

## Implementation details

- Plan validation enforces batch size 5–20, buffer size no greater than two batches, unique shops, at least one shop for enabled plans, and one enabled plan per user/product rule.
- Reservation locks the plan row, computes quota-aware remaining capacity, selects assets by `created_at,id` with `FOR UPDATE OF asset SKIP LOCKED`, uses `allocateRoundRobin`, relies on migration 029's active-assignment unique index, and returns only rows inserted successfully.
- Reservation count is bounded by `batchSize + bufferSize` after subtracting outstanding non-terminal assignments.
- Progress updates validate state transitions, verify listing-batch ownership, derive run status, and prevent an assignment's first `batchId` from being cleared or replaced.
- Release is atomic and rejects any assignment that is not `reserved`, has a `batch_id`, has a generated title, or has mockup results.
- Run listing supports plan/status/date filters and returns typed assignments nested under each run.

## TDD evidence

### RED 1

Command: `cd server; npm test`

Observed failure: `auto-listing-planner.js` did not export `assertAssignmentStatusTransition` (and the new plan validation API was absent).

### GREEN 1

Command: `cd server; npm test`

Observed result: 11 tests passed after the initial plan validation and transition implementation.

### RED 2

Command: `cd server; npm test`

Observed failure: missing export `calculateRemainingShopCapacity`, proving the regression test for double-subtracting outstanding assignments was active.

### GREEN 2

Command: `cd server; npm test; npm run check`

Observed result: 12 tests passed and TypeScript checking succeeded after fixing capacity calculation.

### RED 3

Command: `cd server; npm test`

Observed failure: missing export `assertAssignmentBatchUpdate`, proving the immutable batch-binding guard test was active.

### Final GREEN

Command: `cd server; npm test; npm run check`

Observed result: 13 tests passed, 0 failed; server TypeScript check exited 0.

## Build verification

Command: `npm run build:web`

Result: blocked by parallel frontend work outside Task 3. Current errors are in:

- `src/features/cloud/AutoListingPlansPage.test.tsx`: missing matcher typings for `toBeChecked` and `toHaveValue`.
- `src/features/cloud/AutoListingPlansPage.tsx`: `ShopListingConfig.shopName` type errors.
- `src/features/cloud/GalleryManager.tsx`: missing `listingRunning`, `mockupRunning`, and `titleRunning` fields.

No `build:web` error pointed to Task 3 files.

## Files changed

- `server/src/routes/gallery-auto-listing-routes.ts` (new)
- `server/src/routes/gallery-routes.ts`
- `server/src/auto-listing-planner.ts`
- `server/src/auto-listing-planner.test.ts`
- `src/lib/cloudApi.ts`
- `.superpowers/sdd/2026-07-28-local-auto-listing-implementation/task-3-report.md` (new)

## Known limitations

- This task did not run a live PostgreSQL integration test; transaction and locking behavior is implemented in SQL and type-checked, while the requested server unit suite covers the pure planning and guard rules.
- Full web build remains unavailable until the parallel Task 6/7 TypeScript errors above are resolved.
- Git commands/commit were not run because Git is unavailable in the environment and the user explicitly requested no commit.
