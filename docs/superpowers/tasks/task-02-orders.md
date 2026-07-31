# Task 2 Brief: Order Query Consistency

Execute Task 2 from `docs/superpowers/plans/2026-07-27-web-workspace-stability-redesign.md` using systematic debugging and strict TDD.

Ownership:
- Create `src/features/orders/orderQueryUtils.ts`.
- Create `src/features/orders/orderQueryUtils.test.ts`.
- Modify only `src/features/orders/OrdersPage.tsx` and `src/features/orders/OrdersPage.test.tsx` beyond those new files.

Required behavior:
- Clicking `等待备货` and then `全部` must issue an all-status query and render all-order data.
- Explicit empty status must not fall back to the previous status.
- Only the latest saved-order request may update UI state.
- Status counts must use an unfiltered-by-status summary for the same selected shops and keyword scope.
- Successful reloads clear invalid selected rows.
- Preserve current keyword, shops, and limit behavior.
- Keep changes minimal; do not redesign page layout in this task.

Testing:
- Observe focused tests fail for the expected reasons before implementation.
- Run the focused new utility and OrdersPage tests after implementation.
- Do not run irreversible external actions.

Git is unavailable; do not commit. You are not alone in the codebase. Do not revert other workers' edits or touch GalleryManager/navigation/styles.

Return changed files, RED evidence, GREEN evidence, and self-review concerns.
