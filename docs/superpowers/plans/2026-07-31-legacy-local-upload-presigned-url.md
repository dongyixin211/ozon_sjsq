# Legacy Local Upload Presigned URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the old Excel local listing flow while uploading listing images to the admin-configured cloud OSS through short-lived presigned URLs.

**Architecture:** Reuse the existing cloud direct-upload pattern: server signs a single controlled object URL, desktop uploads with `PUT`, then desktop calls a complete endpoint to record usage and receive the public URL. The local batch listing executor swaps its `AliyunOssClient` dependency for a cloud-backed uploader when cloud base URL and token are present; Ozon submission logic stays unchanged.

**Tech Stack:** Fastify, Zod, PostgreSQL migrations, AWS S3-compatible presigned URLs, Rust/Tauri, reqwest, React/TypeScript, Vitest/node:test.

## Global Constraints

- Do not send or persist admin OSS long-term `AccessKeySecret` on the client.
- Keep old Excel local listing and existing Ozon API submission behavior.
- Remove only the local shop OSS prerequisite for old listing; keep Ozon Key, watermark, Excel, SKU image matching, and automatic post-processing validation.
- Require cloud login and membership before signing uploads.
- Generated object keys must be server-owned and isolated by user and SKU.
- Do not change cloud gallery automatic listing behavior.

---

## File Structure

- Modify `server/src/storage.ts`: expose a `contentTypeForObjectKey`-compatible presigned upload primitive already backed by `createDirectUploadUrl`, `objectExists`, and `publicUrlForObjectKey`.
- Modify `server/src/routes/gallery-routes.ts`: add legacy upload schemas, two endpoints, and DB insert helper near existing direct-upload endpoints.
- Create `server/migrations/033_legacy_listing_uploads.sql`: record confirmed legacy listing uploads.
- Create `server/src/routes/legacy-listing-upload-routes.test.ts`: unit-test object-key safety and complete payload mapping helpers exported from `gallery-routes.ts` or a small helper module.
- Modify `src-tauri/src/core/models.rs`: add optional `cloud_api_base_url` and `cloud_auth_token` to `BatchUploadRequest`.
- Modify `src/lib/api.ts`: inject cloud auth token for `preflight_batch_upload` and `start_batch_upload`.
- Modify `src/features/ozon/OzonPage.tsx`: include `settings.cloudApiBaseUrl` in `uploadRequest()`.
- Modify `src-tauri/src/core/commands.rs`: stop requiring shop OSS for old upload preflight/start; validate cloud auth instead.
- Modify `src-tauri/src/core/batch.rs`: add a `CloudListingImageUploader` and use it in old batch listing image uploads.

---

### Task 1: Server Legacy Upload API

**Files:**
- Create: `server/migrations/033_legacy_listing_uploads.sql`
- Modify: `server/src/routes/gallery-routes.ts`
- Test: `server/src/routes/legacy-listing-upload-routes.test.ts`

**Interfaces:**
- Consumes: `createDirectUploadUrl(objectKey: string, contentType: string)`, `objectExists(objectKey: string)`, `publicUrlForObjectKey(objectKey: string)`, `assertGalleryStorageAvailable(userId: string, incomingBytes: number)`.
- Produces: `buildLegacyListingUploadObjectKey(userId: string, input: { sku: string; filename: string; requestId: string }): string` and endpoints `POST /legacy-listing/uploads/presign`, `POST /legacy-listing/uploads/complete`.

- [ ] **Step 1: Write migration**

Create `server/migrations/033_legacy_listing_uploads.sql`:

```sql
CREATE TABLE IF NOT EXISTS legacy_listing_uploads (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_listing_uploads_user_sku_idx
  ON legacy_listing_uploads(user_id, sku, created_at DESC);
```

- [ ] **Step 2: Write helper tests**

Create `server/src/routes/legacy-listing-upload-routes.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildLegacyListingUploadObjectKey, legacyListingUploadCompleteRecord } from "./gallery-routes.js";

test("legacy listing object keys are server owned and sanitized", () => {
  const key = buildLegacyListingUploadObjectKey("00000000-0000-4000-8000-000000000001", {
    sku: " A/B 商品 001 ",
    filename: "../../photo.PNG",
    requestId: "00000000-0000-4000-8000-000000000002",
  });
  assert.equal(key, "legacy-listing/00000000-0000-4000-8000-000000000001/A_B_商品_001/00000000-0000-4000-8000-000000000002.png");
});

test("legacy listing complete payload maps to insert record", () => {
  assert.deepEqual(legacyListingUploadCompleteRecord("user-a", {
    sku: "sku-a",
    filename: "image.jpg",
    objectKey: "legacy-listing/user-a/sku-a/request-a.jpg",
    publicUrl: "https://cdn.example.com/legacy-listing/user-a/sku-a/request-a.jpg",
    contentType: "image/jpeg",
    sizeBytes: 123,
  }), {
    userId: "user-a",
    sku: "sku-a",
    sourceFilename: "image.jpg",
    objectKey: "legacy-listing/user-a/sku-a/request-a.jpg",
    publicUrl: "https://cdn.example.com/legacy-listing/user-a/sku-a/request-a.jpg",
    contentType: "image/jpeg",
    sizeBytes: 123,
  });
});
```

- [ ] **Step 3: Run failing server tests**

Run: `cd server; npm test -- src/routes/legacy-listing-upload-routes.test.ts`

Expected: FAIL because exported helpers do not exist.

- [ ] **Step 4: Add schemas and helpers**

In `server/src/routes/gallery-routes.ts`, add near existing direct-upload schemas:

```ts
const legacyListingPresignSchema = z.object({
  sku: z.string().trim().min(1).max(240),
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.coerce.number().int().positive().max(MAX_BATCH_UPLOAD_BYTES),
});

const legacyListingCompleteSchema = legacyListingPresignSchema.extend({
  objectKey: z.string().trim().min(1).max(600),
  publicUrl: z.string().url(),
});

export function buildLegacyListingUploadObjectKey(userId: string, input: { sku: string; filename: string; requestId: string }) {
  const sku = input.sku.trim().replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "sku";
  const ext = path.extname(input.filename).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".jpg";
  return `legacy-listing/${userId}/${sku}/${input.requestId}${ext}`;
}

export function legacyListingUploadCompleteRecord(userId: string, body: z.infer<typeof legacyListingCompleteSchema>) {
  return {
    userId,
    sku: body.sku,
    sourceFilename: body.filename,
    objectKey: body.objectKey,
    publicUrl: body.publicUrl,
    contentType: body.contentType,
    sizeBytes: body.sizeBytes,
  };
}
```

- [ ] **Step 5: Add endpoints**

In `galleryRoutes`, before existing `/gallery/assets/direct-upload/prepare`, add:

```ts
app.post("/legacy-listing/uploads/presign", { preHandler: [requireAuth, requireMembership] }, async (request) => {
  assertRateLimit({ key: `legacy-listing:presign:${request.currentUser.id}`, limit: 240, windowMs: 60_000, code: "LEGACY_LISTING_UPLOAD_RATE_LIMITED", message: "本地上架图片上传过于频繁，请稍后重试" });
  const body = legacyListingPresignSchema.parse(request.body);
  await assertGalleryStorageAvailable(request.currentUser.id, body.sizeBytes);
  const objectKey = buildLegacyListingUploadObjectKey(request.currentUser.id, { sku: body.sku, filename: body.filename, requestId: newId() });
  const { uploadUrl, expiresIn } = await createDirectUploadUrl(objectKey, body.contentType);
  return { ok: true, objectKey, uploadUrl, expiresIn, publicUrl: publicUrlForObjectKey(objectKey) };
});

app.post("/legacy-listing/uploads/complete", { preHandler: [requireAuth, requireMembership] }, async (request) => {
  const body = legacyListingCompleteSchema.parse(request.body);
  if (!body.objectKey.startsWith(`legacy-listing/${request.currentUser.id}/`)) {
    throw new AppError(403, "LEGACY_LISTING_OBJECT_FORBIDDEN", "不能确认其他用户的上传对象");
  }
  const exists = await objectExists(body.objectKey);
  if (!exists) throw new AppError(404, "LEGACY_LISTING_OBJECT_NOT_FOUND", "上传对象不存在，请重新上传");
  const record = legacyListingUploadCompleteRecord(request.currentUser.id, body);
  await pool.query(`
    INSERT INTO legacy_listing_uploads (id, user_id, sku, source_filename, object_key, public_url, content_type, size_bytes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (object_key) DO UPDATE SET public_url = excluded.public_url, size_bytes = excluded.size_bytes
  `, [newId(), record.userId, record.sku, record.sourceFilename, record.objectKey, record.publicUrl, record.contentType, record.sizeBytes]);
  return { ok: true, publicUrl: record.publicUrl };
});
```

- [ ] **Step 6: Verify server task**

Run: `cd server; npm test -- src/routes/legacy-listing-upload-routes.test.ts`

Expected: PASS.

---

### Task 2: Request Cloud Session For Old Listing

**Files:**
- Modify: `src-tauri/src/core/models.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/features/ozon/OzonPage.tsx`
- Modify: `src-tauri/src/core/commands.rs`

**Interfaces:**
- Consumes: `BatchUploadRequest` JSON from React.
- Produces: `BatchUploadRequest.cloud_api_base_url: Option<String>` and `BatchUploadRequest.cloud_auth_token: Option<String>` for Rust upload code.

- [ ] **Step 1: Extend request type**

In `src-tauri/src/core/models.rs`, add fields to `BatchUploadRequest`:

```rust
    pub cloud_api_base_url: Option<String>,
    pub cloud_auth_token: Option<String>,
```

- [ ] **Step 2: Add frontend base URL**

In `src/features/ozon/OzonPage.tsx`, add to `uploadRequest()`:

```ts
    cloudApiBaseUrl: settings.cloudApiBaseUrl,
```

- [ ] **Step 3: Inject auth token**

In `src/lib/api.ts`, update `withCloudAuthToken()` command list to include:

```ts
      || command === "preflight_batch_upload"
      || command === "start_batch_upload"
```

- [ ] **Step 4: Change preflight OSS requirement**

In `src-tauri/src/core/commands.rs`, change `preflight_batch_upload` to call:

```rust
let shops = shops_for_preflight(&state, &request.shop_ids, false, &mut issues)?;
```

Then add a preflight cloud-session check:

```rust
if request.cloud_api_base_url.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_none()
    || request.cloud_auth_token.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_none()
{
    issues.push(issue("error", "统一 OSS", "请先登录云端会员账号后使用统一 OSS 上架", "登录会员账号", "ozon"));
}
```

- [ ] **Step 5: Change start runtime creation**

In `start_batch_upload`, remove the fallback call that resolves `db.shop_with_effective_oss(shop_id)` and construct `RuntimeShopConfig` with `oss_secret: None`. Keep `db.shop_api_key(shop_id)` unchanged.

- [ ] **Step 6: Verify TypeScript compile**

Run: `npm run build`

Expected: TypeScript compile succeeds or fails only on unrelated existing Rust/Tauri build requirements; no `BatchUploadRequest` property type error remains.

---

### Task 3: Cloud Uploader In Rust Batch Flow

**Files:**
- Modify: `src-tauri/src/core/batch.rs`

**Interfaces:**
- Consumes: `BatchUploadRequest.cloud_api_base_url`, `BatchUploadRequest.cloud_auth_token` from Task 2 and server endpoints from Task 1.
- Produces: `CloudListingImageUploader::upload_file(&self, path: &Path, sku: &str, filename: &str) -> Result<String>`.

- [ ] **Step 1: Add upload response structs**

In `src-tauri/src/core/batch.rs`, add:

```rust
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPresignResponse {
    object_key: String,
    upload_url: String,
    public_url: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCompleteResponse {
    public_url: String,
}
```

- [ ] **Step 2: Add cloud uploader struct**

Add:

```rust
#[derive(Clone)]
struct CloudListingImageUploader {
    client: reqwest::Client,
    base_url: String,
    token: String,
}

impl CloudListingImageUploader {
    fn new(base_url: &str, token: &str) -> Result<Self> {
        let base_url = base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() || token.trim().is_empty() {
            anyhow::bail!("请先登录云端会员账号后使用统一 OSS 上架");
        }
        Ok(Self { client: reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build()?, base_url, token: token.trim().to_string() })
    }

    async fn upload_file(&self, path: &Path, sku: &str, filename: &str) -> Result<String> {
        let bytes = tokio::fs::read(path).await.with_context(|| format!("读取上传图片失败：{}", path.display()))?;
        let content_type = if filename.to_ascii_lowercase().ends_with(".png") { "image/png" } else { "image/jpeg" };
        let presign = self.client.post(format!("{}/legacy-listing/uploads/presign", self.base_url))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "sku": sku, "filename": filename, "contentType": content_type, "sizeBytes": bytes.len() }))
            .send().await?.error_for_status()?.json::<LegacyPresignResponse>().await?;
        self.client.put(&presign.upload_url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(bytes)
            .send().await?.error_for_status()?;
        let complete = self.client.post(format!("{}/legacy-listing/uploads/complete", self.base_url))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "sku": sku, "filename": filename, "objectKey": presign.object_key, "publicUrl": presign.public_url, "contentType": content_type, "sizeBytes": std::fs::metadata(path)?.len() }))
            .send().await?.error_for_status()?.json::<LegacyCompleteResponse>().await?;
        Ok(complete.public_url)
    }
}
```

- [ ] **Step 3: Build uploader once per job**

At the start of `run_batch_upload`, create:

```rust
let uploader = CloudListingImageUploader::new(
    request.cloud_api_base_url.as_deref().unwrap_or_default(),
    request.cloud_auth_token.as_deref().unwrap_or_default(),
)?;
```

Pass `&uploader` into `process_upload_row` instead of `&AliyunOssClient`.

- [ ] **Step 4: Replace object-key OSS upload**

In `process_upload_row`, replace `build_oss_object_key(...)` and `oss.upload_file(...)` with:

```rust
jobs.log(job_id, "info", &format!("{} 合并水印后上传统一 OSS: {}", row.sku, filename));
let upload_path = prepare_watermarked_upload_image(&image, watermark_path, upload_temp_root, &row.sku)?;
image_urls.push(uploader.upload_file(&upload_path, &row.sku, filename).await?);
```

Remove the now-unused `build_oss_object_key`, `build_oss_folder`, and `AliyunOssClient` imports only from `batch.rs` if they are no longer used by batch update image code. If listed-update code still uses `oss_client`, keep those imports and function.

- [ ] **Step 5: Verify Rust compile**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS or only unrelated environment dependency failure; no missing field, unused import, or type mismatch in `batch.rs`.

---

### Task 4: Regression And End-To-End Checks

**Files:**
- Modify only files already touched if verification exposes issues directly caused by Tasks 1-3.

**Interfaces:**
- Consumes: all Tasks 1-3.
- Produces: verified old listing path with cloud OSS upload authorization.

- [ ] **Step 1: Run server tests**

Run: `cd server; npm test`

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run: `npm test -- --runInBand`

Expected: PASS, or document unsupported flag and run `npm test`.

- [ ] **Step 3: Run frontend build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Run Rust check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 5: Manual smoke with a non-OSS shop**

Use a test user with no local shop OSS values. Log into cloud, open old Excel listing, choose a valid shop, Excel, and image folder, then click preflight.

Expected: no “OSS 配置不完整，请先在主店配置 OSS”; preflight blocks only if cloud login/member, Ozon Key, watermark, Excel, or image matching fails.

- [ ] **Step 6: Manual upload smoke**

Start old Excel listing with one SKU and one image against a test Ozon/shop environment.

Expected: logs show “上传统一 OSS”; `legacy_listing_uploads` has one row for the user/SKU; Ozon request uses the returned cloud public URL.
