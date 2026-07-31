# Full-Project Baseline Audit — 2026-07-27

## Scope Inventory

- Browser workspace page keys: 15.
- Registered Tauri commands: 72.
- Cloud server route modules: 9, plus 7 inline routes.
- Sequential database migrations: 28.
- Local job kinds: 16.
- Frontend test files: 11, containing 51 tests.

Direct automated coverage gaps at baseline include application shells/navigation, `MaterialsPage`, `CloudPage`, `LicensePage`, `ProductCatalogPage`, and server routes.

## Command Results

| Command | Result | Evidence |
| --- | --- | --- |
| `npm test` | FAIL | 11 files; 50 passed, 1 failed. Failure at `src/features/orders/OrdersPage.test.tsx:196`: shipping-label download spy received 0 calls. |
| `npm run build` | PASS | Vite reported mixed static/dynamic Tauri API import and chunk size over 500 kB warnings. |
| `npm run build:web` | PASS | Same two Vite warnings. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS | 81 passed, 0 failed. Existing unused `read_progress` warning at `src-tauri/src/core/local_mockup.rs:1953`. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | FAIL | Existing formatting difference at `src-tauri/src/core/order_docs.rs:156`. |
| `npm run check` in `server` | PASS | TypeScript no-emit check succeeded. |
| `npm run build` in `server` | PASS | Server build and public asset copy succeeded. |

## Baseline Classification

- The OrdersPage logistics-download test failure existed before production changes in this implementation phase and must remain visible while order test setup is corrected.
- Rust formatting failure at `order_docs.rs:156` predates this phase and must not be hidden by unrelated formatting.
- Vite chunk and import warnings are non-blocking baseline warnings.
- No production code was changed to produce this report.
