# Task 8-10 Brief: Verification, Browser Smoke, and Final Audit

Execute Tasks 8-10 after implementation and consistency fixes are accepted.

Ownership:
- Update `docs/testing/2026-07-27-baseline-audit.md`.
- Create/update `docs/testing/2026-07-27-final-function-audit.md`.
- Do not change production code unless a verification failure is assigned as a separate fix task.

Commands:
- Root: `npm test`, `npm run build`, `npm run build:web`.
- Rust: full Cargo tests and fmt check.
- Server: `npm run check`, `npm run build`.

Browser smoke:
- Five modules and every child page reachable.
- Desktop and narrow viewports.
- Filters, tabs, pagination, template save/refresh/restore, dialogs, task details, empty/loading/error states.
- Stop before irreversible publish, ship, delete, paid AI, or other final external submission.
- Record authentication and environment blockers.

Final report:
- Function inventory and result for each item.
- Exact automated counts and command evidence.
- Data consistency invariant results.
- Bugs fixed and known remaining issues.
- External checks not executed and why.

Git is unavailable; do not commit.
