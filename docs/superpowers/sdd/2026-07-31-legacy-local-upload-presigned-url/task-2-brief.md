# Task 2 Brief: Request Cloud Session For Old Listing

Plan file: docs/superpowers/plans/2026-07-31-legacy-local-upload-presigned-url.md
Spec file: docs/superpowers/specs/2026-07-31-legacy-local-upload-presigned-url-design.md

Implement Task 2 only.

## Files
- Modify: src-tauri/src/core/models.rs
- Modify: src/lib/api.ts
- Modify: src/features/ozon/OzonPage.tsx
- Modify: src-tauri/src/core/commands.rs
- Report: docs/superpowers/sdd/2026-07-31-legacy-local-upload-presigned-url/task-2-report.md

## Requirements
- Add optional cloud API base URL and cloud auth token to `BatchUploadRequest`.
- Ensure old Excel upload request includes `settings.cloudApiBaseUrl`.
- Ensure API wrapper injects `getCloudToken()` into `preflight_batch_upload` and `start_batch_upload` requests.
- Change old upload preflight so it no longer requires shop OSS.
- Add preflight blocking issue when cloud base URL or token is missing: scope `统一 OSS`, message `请先登录云端会员账号后使用统一 OSS 上架`.
- Change `start_batch_upload` runtime creation so it does not require or resolve shop OSS. Keep Ozon API Key lookup and shop/watermark behavior unchanged.
- Do not touch `batch.rs`; Task 3 owns actual uploader replacement.

## Verification
Run focused TypeScript check if feasible:
`npm run build`

Run Rust check if feasible:
`cargo check --manifest-path src-tauri/Cargo.toml`

If commands fail because the environment lacks a tool, record the exact failure.

Write report to docs/superpowers/sdd/2026-07-31-legacy-local-upload-presigned-url/task-2-report.md
