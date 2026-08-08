import assert from "node:assert/strict";
import test from "node:test";
import {
  isEligibleLegacyListingUpload,
  isLegacyListingObjectKey,
  summarizeLegacyListingCleanup,
} from "../legacy-listing-upload-cleanup.js";

const now = new Date("2026-08-05T00:00:00.000Z");

test("legacy cleanup uses a strict one-day retention boundary", () => {
  assert.equal(isEligibleLegacyListingUpload({ userId: "user-a", objectKey: "legacy-listing/user-a/a.jpg", sizeBytes: 10, createdAt: new Date("2026-08-03T23:59:59.999Z"), hasActiveGrant: false }, now), true);
  assert.equal(isEligibleLegacyListingUpload({ userId: "user-a", objectKey: "legacy-listing/user-a/b.jpg", sizeBytes: 10, createdAt: new Date("2026-08-04T00:00:00.000Z"), hasActiveGrant: false }, now), false);
});

test("active grants protect old completed upload records", () => {
  assert.equal(isEligibleLegacyListingUpload({ userId: "user-a", objectKey: "legacy-listing/user-a/a.jpg", sizeBytes: 10, createdAt: new Date("2026-07-01T00:00:00.000Z"), hasActiveGrant: true }, now), false);
});

test("cleanup only accepts server-owned user object keys", () => {
  assert.equal(isLegacyListingObjectKey("legacy-listing/user-a/a.jpg", "user-a"), true);
  assert.equal(isLegacyListingObjectKey("legacy-listing/user-b/a.jpg", "user-a"), false);
  assert.equal(isLegacyListingObjectKey("legacy-listing/user-a/../a.jpg", "user-a"), false);
  assert.equal(isLegacyListingObjectKey("legacy-listing/user-a\\a.jpg", "user-a"), false);
});

test("cleanup summary reports protected rows and reclaimable bytes", () => {
  const summary = summarizeLegacyListingCleanup([
    { userId: "user-a", objectKey: "legacy-listing/user-a/a.jpg", sizeBytes: 100, createdAt: new Date("2026-07-01"), hasActiveGrant: false },
    { userId: "user-a", objectKey: "legacy-listing/user-a/b.jpg", sizeBytes: 200, createdAt: new Date("2026-08-04"), hasActiveGrant: false },
    { userId: "user-a", objectKey: "legacy-listing/user-a/c.jpg", sizeBytes: 300, createdAt: new Date("2026-07-01"), hasActiveGrant: true },
  ], now);
  assert.equal(summary.eligible.length, 1);
  assert.equal(summary.protectedCount, 2);
  assert.equal(summary.eligibleBytes, 100);
});
