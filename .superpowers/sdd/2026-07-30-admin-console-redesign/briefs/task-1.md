# Task 1 — Establish Admin Lifecycle Schema and Shared Page Contract

Plan: docs/superpowers/plans/2026-07-30-admin-console-redesign.md

Ownership:
- server/migrations/032_admin_console_lifecycle.sql
- server/src/admin-pagination.ts
- server/src/admin-pagination.test.ts
- server/src/routes/admin-routes.ts (only imports and query schema defaults)

Constraints:
- No dependencies.
- Admin list default is limit=10 and exposes deletionState active/deleted/all.
- All future deletes must be logical; do not add physical deletes.
- Do not edit frontend or unrelated resources.
- Follow TDD: add a test, run it and observe failure, implement minimum code, rerun focused test and server typecheck.
- You are not alone in the codebase. Do not revert other agents' changes and adapt to concurrent edits.

Deliverable report:
- Write a concise report to .superpowers/sdd/2026-07-30-admin-console-redesign/reports/task-1.md.
- Include changed paths, exact commands/output summary, and any concerns.
