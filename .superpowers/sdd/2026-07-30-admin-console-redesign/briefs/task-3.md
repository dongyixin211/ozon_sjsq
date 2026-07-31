# Task 3 — Source-First Gallery and Featured-Gallery Administration

Plan: docs/superpowers/plans/2026-07-30-admin-console-redesign.md

Ownership:
- server/src/routes/admin-routes.ts (gallery and new featured-gallery route blocks)
- server/src/featured-gallery.ts
- server/src/routes/gallery-routes.ts (featured query lifecycle filter only)
- server/src/admin-pagination.test.ts (contract tests)

Constraints:
- Every Gallery Assets row is a source/original image. Keep the existing result-asset exclusion in its outer list query.
- Related mockup rows return only in asset/featured detail payloads through `gallery_mockup_results.source_asset_id`; never page or count them independently.
- Featured Gallery aggregates the existing `featured_gallery_assets` records that drive the user-side view. The admin UI must not derive eligibility from orders.
- Add default limit=10, deletionState, filters, detail, CRUD, logical delete, and restore exactly as the plan says.
- The customer `/gallery/featured-assets` endpoint must omit soft-deleted feature records.
- You are not alone in the codebase. Do not revert other work. No commits; Git CLI is unavailable.
- Follow TDD and report test evidence to `.superpowers/sdd/2026-07-30-admin-console-redesign/reports/task-3.md`.
