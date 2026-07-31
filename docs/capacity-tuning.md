# Capacity tuning notes

This project is optimized first by moving bandwidth and image work away from the API server.

## Runtime switches

Recommended production defaults:

```env
DB_POOL_MAX=20
CORS_ORIGINS=https://api.example.com,https://app.example.com
LEGACY_UPLOAD_ENABLED=true
LEGACY_UPLOAD_MAX_FILES=20
LEGACY_UPLOAD_MAX_BYTES_MB=48
CLOUD_MOCKUP_RENDER_ENABLED=false
CLOUD_MOCKUP_REQUEST_CONCURRENCY=1
TITLE_GENERATION_GLOBAL_CONCURRENCY=2
TITLE_GENERATION_USER_CONCURRENCY=1
```

For a 2-core / 4-GB server, keep these title-generation values at `2` and `1`. Batch image processing is also limited to two workers per upload task, while cloud mockup rendering defaults to one concurrent request.

## Request observation

The API logs every request taking 500 ms or longer as `slow request`. Each entry includes the matched route, request parameter size, database query count and elapsed time, heap/RSS memory, and the process event-loop p95 delay. Use these records to identify the next bottleneck before changing SQL or server capacity.

The supplied Nginx configuration caches `/app/assets/` for one year and enables gzip for JavaScript, CSS, JSON, SVG, and related text assets. Standard Ubuntu Nginx does not include Brotli by default, so do not add `brotli` directives unless the server has an Nginx Brotli module installed.

The server always appends trusted desktop-client origins such as `http://tauri.localhost` to the configured CORS list, so packaged Tauri clients can still check cloud health and call the API after production CORS is tightened.

After all clients have upgraded to direct object-storage upload, set:

```env
LEGACY_UPLOAD_ENABLED=false
```

## PostgreSQL observation

Enable slow-query logging on the server before opening to more users:

```conf
log_min_duration_statement = 500
shared_preload_libraries = 'pg_stat_statements'
```

Then restart PostgreSQL and enable the extension:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Useful query:

```sql
SELECT query, calls, mean_exec_time, max_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

## Read-only gallery load test

Use an existing normal user token:

```bash
LOAD_AUTH_TOKEN="Bearer-token-without-Bearer-prefix" \
LOAD_CONCURRENCY=50 \
LOAD_REQUESTS=500 \
LOAD_INCLUDE_TOTAL=false \
npm run perf:gallery
```

Run once with `LOAD_INCLUDE_TOTAL=true` and once with `false`. The `false` run should be cheaper and faster because it skips `COUNT(*)`.

## Direct-upload smoke test

Use a normal user token and a small count first. This verifies the API only prepares and completes object-storage uploads while image bytes go directly to storage.

```bash
DIRECT_UPLOAD_AUTH_TOKEN="Bearer-token-without-Bearer-prefix" \
DIRECT_UPLOAD_COUNT=5 \
DIRECT_UPLOAD_CONCURRENCY=2 \
npm run perf:direct-upload
```

Optional variables:

```env
DIRECT_UPLOAD_BASE_URL=http://127.0.0.1:8787
DIRECT_UPLOAD_PRODUCT_IMAGE_RULE_ID=rule-uuid
DIRECT_UPLOAD_WIDTH=900
DIRECT_UPLOAD_HEIGHT=1200
DIRECT_UPLOAD_WRITE_REPORT=true
```

The script writes JSON reports to `server/reports/` by default. Increase `DIRECT_UPLOAD_COUNT` and `DIRECT_UPLOAD_CONCURRENCY` gradually after the small smoke run succeeds.
