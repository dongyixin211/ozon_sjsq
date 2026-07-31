# Task 6 Brief: Orders and Listing Composition

Execute Task 6 from the master plan after Tasks 2, 3, and 5 are accepted.

Ownership:
- Modify `src/features/orders/OrdersPage.tsx` and `OrdersPage.test.tsx`.
- Modify `src/features/cloud/GalleryManager.tsx` and `GalleryManager.test.tsx`.
- Modify only CSS classes specifically used by those pages.

Requirements:
- Preserve all corrected business logic from Tasks 2 and 3.
- Orders: one clear primary sync action, independent status metrics, compact filters, results, contextual selected-order actions, and advanced low-frequency manual/cookie/download configuration.
- Listing: separate workflow summary, image-rule/mockup selection, shop/template setup, and selected-image actions; collapse low-frequency automation settings by default.
- Do not delete features or change external API behavior.
- Preserve keyboard behavior, accessible names, dialog behavior, and responsive use.

Testing:
- Add failing structure/interaction expectations first.
- Run focused OrdersPage and GalleryManager tests after implementation.
- Run build and browser smoke for both pages.

Git is unavailable; do not commit. You are not alone in the codebase. Preserve changes from earlier workers and avoid global navigation refactors.
