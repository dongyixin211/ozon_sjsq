# Automatic Listing Quota Design

## Goal

Make automatic listing target 100 successful Ozon submissions per configured shop per day, with 12 shops supported (1200 planned submissions/day), automatic unused-image selection, per-shop templates, continuous replenishment, retry, and progress tracking.

## Scope

- Count quota independently per external shop.
- Treat a successful Ozon submission as the client-side completion target; continue polling Ozon asynchronously for final product status.
- Select only eligible unused source assets and reserve them transactionally.
- Render the configured mockup, generate the configured title, and submit each shop's products using its saved product template.
- Keep retryable failures available for retry without reusing successful source assets.
- Preserve existing inventory, barcode, and action maintenance behavior.

## Scheduling Rules

- Daily target per shop: 100.
- Remaining target: `max(0, 100 - successful submissions today - active assignments)`.
- Respect the live Ozon create and total quotas; configurable safety reserve defaults to zero for the requested 100-item limit.
- Allocate candidates by each shop's remaining target and live quota, with deterministic round-robin balancing for ties.
- Continue reserving batches until every shop reaches its target or no eligible assets remain.
- The scheduler stays awake while the plan has remaining target or active work; it must not require manual image selection.

## Throughput and Recovery

- Use bounded concurrent shop submission workers rather than one global serial queue.
- Reuse completed mockup results after a retry or restart.
- Retry transient image, network, and Ozon submission failures with bounded backoff.
- Persist scheduler checkpoint and report per-shop target, reserved, submitted, failed, and remaining counts.
- Emit an explicit warning when the one-hour submission target cannot be met because of Ozon throttling, unavailable assets, missing templates, or invalid credentials.

## Acceptance Criteria

1. With 12 eligible shops and at least 1200 eligible assets, a daily run plans no more than 100 successful submissions per shop and can reserve all 1200 without manual selection.
2. Existing usage, mockup, assignment, and listing-batch records exclude an asset from future selection.
3. A shop with a smaller live quota receives only its available capacity; other shops continue independently.
4. Completed submissions are not retried or counted twice after restart.
5. A transient failure is retried, while a permanent validation failure is recorded and does not block other shops.
6. Tests cover quota calculation, allocation, refill behavior, de-duplication, retry classification, and checkpoint recovery.
7. The one-hour metric is reported as submission acceptance/progress, not assumed final Ozon publication.
