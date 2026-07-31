# Task 5 Brief: Workspace Visual System

Execute Task 5 from the master plan after Task 4 navigation is accepted.

Ownership:
- Modify `src/styles.css`.
- Modify only shell/header markup in `src/App.tsx` if required for styling.
- Modify `src/features/dashboard/DashboardPage.tsx` and its test only for the shared page-header/metric structure.

Requirements:
- Introduce one coherent blue/white token system for background, surfaces, borders, text, states, radii, shadows, and spacing.
- Reduce sidebar noise and make five primary modules obvious.
- Standardize page headers, cards, metrics, toolbars, filters, tabs, tables, empty states, feedback, and dialogs using existing classes where possible.
- Keep data-heavy desktop layouts practical and preserve responsive behavior at 1280, 1024, 900, and 390 widths.
- Only lightly align LocalAssistantShell; do not add business UI to Tauri.
- Do not copy reference-site branding or assets.
- Avoid unrelated component rewrites.

Testing:
- Add or update semantic structure tests before markup changes.
- Run dashboard/navigation tests and both frontend builds.
- Perform browser screenshots at specified widths without external side effects.

Git is unavailable; do not commit. You are not alone in the codebase. Do not touch OrdersPage or GalleryManager in this task.
