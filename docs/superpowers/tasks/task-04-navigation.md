# Task 4 Brief: Five-Module Workspace Navigation

Execute Task 4 from `docs/superpowers/plans/2026-07-27-web-workspace-stability-redesign.md` using strict TDD.

Ownership:
- Create `src/workspace/navigation.ts`.
- Create `src/workspace/navigation.test.ts`.
- Create `src/workspace/WorkspaceModuleTabs.tsx`.
- Create `src/workspace/WorkspaceModuleTabs.test.tsx`.
- Modify only `src/App.tsx` beyond those new files.

Required module mapping:
- Home: `dashboard`.
- Assets: `materialPortrait`, `materialAiImage`, `materialTitle`, `materialRename`, `imageUpload`, `imagePending`, `imageProcessing`, `imageUploaded`, `imageFeatured`.
- Listing: `ozon`, `productCatalog`.
- Orders: `orders`.
- Tasks/Settings: `jobs`, `license`.

Required behavior:
- All existing PageKey values remain reachable exactly once.
- Sidebar shows only five primary modules.
- Active module child pages render as internal tabs below the page header/top bar.
- Existing page components, page keys, task count, assistant status, refresh, and browser-workspace actions remain functional.
- Tauri `LocalAssistantShell` remains lightweight and does not receive business navigation.
- Preserve localStorage compatibility where reasonable; old open-nav-group state may be ignored if no longer relevant.

Testing:
- Start with failing mapping and tab tests.
- Assert complete/unique page coverage with literal expected page keys.
- Assert tab accessible names and navigation callback behavior.
- Run focused navigation tests and relevant App tests/build.

Git is unavailable; do not commit. You are not alone in the codebase. Do not revert other workers' edits and do not touch OrdersPage, GalleryManager, or global styles.
