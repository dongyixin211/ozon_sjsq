# Task 6 Report: Automatic Listing Plan Wizard

## Scope

- Created `src/features/cloud/autoListingUtils.ts`.
- Created `src/features/cloud/AutoListingPlansPage.tsx`.
- Created `src/features/cloud/AutoListingPlansPage.test.tsx`.
- Added `autoListingPlans` to `src/workspace/navigation.ts` and its tests.
- Rendered the new page from `src/App.tsx`.
- Did not modify `src/lib/cloudApi.ts`, `src/features/cloud/GalleryManager.tsx`, or `src/styles.css`.

## Implementation

- Added a four-step wizard for content templates, shop templates, scheduling, and configuration review.
- Reused the existing cloud product-rule, mockup, prompt, shop, product-template, and listing-preference APIs.
- Reused `buildInitialListingSetup` for preference/shop merging and the local template/warehouse APIs for execution checks.
- Added `validateAutoListingPlanDraft` for required selections, shop product/local templates, batch range 5–20, buffer maximum of two batches, and execution-window validity.
- Added saved-plan summaries for product type, mockup, title prompt, shops, and execution window.
- Consumed the Task 3 `CloudClient.listAutoListingPlans` and `CloudClient.saveAutoListingPlan` interfaces directly.

## TDD Evidence

- RED page test: `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx` failed because `./AutoListingPlansPage` did not exist.
- RED navigation test: `npm test -- src/workspace/navigation.test.ts` failed because `autoListingPlans` was absent from the listing module and page map.
- GREEN focused tests: `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx src/workspace/navigation.test.ts` passed 10/10 tests in 2 files.

## Build

- Command: `npm run build`.
- Result: blocked by three out-of-scope Task 7 parallel errors in `src/features/cloud/GalleryManager.tsx`:
  - line 5982: `listingRunning` is not on `CloudListingBatchProgressSummary`.
  - line 5985: `mockupRunning` is not on `CloudListingBatchProgressSummary`.
  - line 5985: `titleRunning` is not on `CloudListingBatchProgressSummary`.
- TypeScript reported no Task 6 file errors before stopping with those existing parallel errors.

## Limitations

- The Task 6 wizard saves new plans; pause, manual execution, and Task 7 batch-center actions remain outside this task.
- No new CSS was added to avoid conflicts with Task 7; the page uses existing shared classes.
- No git commit was created, as requested.
