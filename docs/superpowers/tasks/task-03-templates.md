# Task 3 Brief: Listing Template Initialization

Execute Task 3 from `docs/superpowers/plans/2026-07-27-web-workspace-stability-redesign.md` using systematic debugging and strict TDD.

Ownership:
- Create `src/features/cloud/listingSetupUtils.ts`.
- Create `src/features/cloud/listingSetupUtils.test.ts`.
- Modify only `src/features/cloud/GalleryManager.tsx` and `src/features/cloud/GalleryManager.test.tsx` beyond those new files.

Required behavior:
- Cloud shops, local shops, cloud product templates, local Ozon templates, and saved listing preferences initialize deterministically regardless of response order.
- Initialization must not autosave defaults before all required sources settle.
- Saved shop configs must not be deleted merely because a shop source has not loaded yet.
- Missing saved template IDs remain visible as unavailable selections with a warning, not silently cleared.
- Saving a product template updates the template collection and saves the updated listing preference snapshot without stale React state.
- Template arrays must not be truncated; group shared/current-shop/other options where the current UI renders them.
- Preserve existing listing and upload behavior outside configuration initialization.

Testing:
- Observe focused tests fail for expected reasons before implementation.
- Cover preferences-first and shops-first initialization orders, no autosave before ready, and remount restoration.
- Run focused GalleryManager and utility tests after implementation.

Git is unavailable; do not commit. You are not alone in the codebase. Do not revert other workers' edits or touch OrdersPage/navigation/global styles.

Return changed files, RED evidence, GREEN evidence, and self-review concerns.
