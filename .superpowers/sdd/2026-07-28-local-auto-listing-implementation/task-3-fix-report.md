# Task 3 Fix Report

Date: 2026-07-28

## Summary

Completed the remaining Task 3 fixes without rolling back prior work:

- Manual listing now locks active automatic assignments in the same transaction before proceeding.
- Execution snapshots are derived from one immutable plan snapshot, so edited plans do not affect already reserved runs or assignments.
- Reservation still uses outstanding-aware round-robin allocation, and the regression coverage now makes that behavior explicit.
- Enabled plan reservations re-check that every referenced shop belongs to the current user.

## Files Updated

- `server/src/auto-listing-reservation.ts`
- `server/src/routes/gallery-auto-listing-routes.ts`
- `server/src/auto-listing-reservation.test.ts`

## What Changed

- `assertManualAssetsAvailableForListing` now locks matching rows from `gallery_auto_listing_assignments` with `FOR UPDATE OF assignment` instead of a read-only existence check.
- `buildExecutionSnapshots` now clones the plan once and derives the shop snapshot from that immutable plan copy.
- `reserveBatch` now reuses `assertEnabledPlanShopsOwned` on the parsed `shopConfigs` before computing capacity and allocations.

## Regression Coverage

- Manual listing rejects active auto assignments and now asserts the assignment-lock query shape.
- Execution snapshots stay unchanged after the editable plan object is mutated.
- Inserted assignments keep both the plan snapshot and per-shop snapshot values.
- Enabled plans reject shop IDs outside the current user.
- Outstanding-aware shop allocation remains covered by the existing planner tests.

## Verification

Ran from `server`:

- `npm test` — PASS, 19 tests, 0 failed
- `npm run check` — PASS, TypeScript `--noEmit` exited 0

## Migration Note

No new migration was needed. `server/migrations/030_auto_listing_snapshots.sql` already adds and backfills `plan_snapshot` and `shop_snapshot` for runs and assignments.
