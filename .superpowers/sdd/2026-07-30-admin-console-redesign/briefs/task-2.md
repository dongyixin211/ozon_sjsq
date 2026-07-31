# Task 2 — Normalize Existing Account and License Management APIs

Plan: docs/superpowers/plans/2026-07-30-admin-console-redesign.md

Precondition: Task 1 must provide `adminListQuerySchema` and migration lifecycle fields.

Ownership:
- server/src/routes/admin-routes.ts (user and license route blocks only)
- server/src/public/admin/admin.js (account and license controller regions only, after Task 5 creates the file)

Constraints:
- Lists return `{ ok, items, total, limit, offset }` with `limit=10` default.
- Use logical DELETE and POST restore only.
- Preserve current admin token auth, current license batch generation, bindings, and user device/storage behavior.
- Do not edit Gallery, Featured Gallery, Orders, Rules, Mockups, AI, HTML, CSS, or migrations.
- Frontend changes wait until Task 5 asset split is complete; if it is not complete, implement and test server work only and record the deferment.
- You are not alone in the codebase. Do not revert other agents' changes.
