# Task 6 Fix Report: Automatic Listing Plan Wizard

## Scope

- Modified `src/features/cloud/autoListingUtils.ts`.
- Modified `src/features/cloud/AutoListingPlansPage.tsx`.
- Modified `src/features/cloud/AutoListingPlansPage.test.tsx`.
- Reviewed but did not change `src/workspace/navigation.ts`, `src/workspace/navigation.test.ts`, or `src/App.tsx`; their existing Task 6 wiring remains valid.
- Did not modify Task 7 files and did not create a git commit.

## Fixes

### Existing plan editing

- Added an explicit “编辑” entry on every saved plan card.
- Editing opens the same four-step wizard with the saved values prefilled.
- The edit draft retains the plan `id`, so `saveAutoListingPlan` uses the existing update/PUT path.
- A successful update replaces the same plan in the local list instead of creating a duplicate.

### Save-time configuration validation

- Validation now receives the currently loaded cloud product templates, local execution templates, local shops, warehouses, and warehouse-load status.
- Saving is blocked when a selected cloud product template or local execution template no longer exists.
- Invalid or empty local template snapshots are rejected.
- Enabled plans are blocked when a local shop is missing, disabled, missing Ozon Client ID, or missing Ozon API Key.
- Enabled stock-updating plans are blocked when the local template has no warehouse, warehouse loading failed, or the configured warehouse is unavailable.
- Step 4 configuration checks now display the same real template, shop credential, and warehouse state used by save validation.

### Chinese cloud errors

- Added focused automatic-listing error translation.
- The enabled-plan conflict now displays: “该商品类型已有启用方案，请先编辑或停用原方案”.
- Known not-found, invalid execution-window, duplicate-shop, membership, and authentication failures also have Chinese messages.
- Unknown English cloud errors use a safe Chinese fallback instead of exposing raw backend text.

## Regression Tests

Added coverage for:

- Existing plan edit prefill and save with the existing `id`.
- Deleted cloud product template.
- Deleted local execution template.
- Missing Ozon Client ID.
- Missing Ozon API Key.
- Disabled local shop.
- Stock update without a configured warehouse.
- Warehouse loading failure.
- Chinese translation of the enabled-plan conflict.

## Verification

- Command: `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx src/workspace/navigation.test.ts`
- Result: 2 test files passed, 19/19 tests passed.
- Command: `npm run build`
- Result: passed; TypeScript and Vite production build completed successfully.
- Build emitted only existing Vite chunk/dynamic-import warnings.
- Task 7 no longer blocks the build in the current workspace.

## Notes

- The existing four-step flow and navigation/App integration were preserved.
- The environment still has no usable `git` command, so no git status/diff or commit was produced.
