import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLegacyListingUploadObjectKey,
  legacyListingStorageLimitBytes,
  legacyListingStorageUsageTotals,
  parseLegacyListingCompleteBody,
  legacyListingUploadCompleteRecord,
  validateLegacyListingUploadGrant,
  validateLegacyListingUploadObjectMetadata,
  validateLegacyListingUploadQuota,
} from "./gallery-routes.js";
import { publicUrlForObjectKey } from "../storage.js";
const activeGrant = {
  id: "grant-a",
  userId: "user-a",
  sku: "sku-a",
  sourceFilename: "image.jpg",
  objectKey: "legacy-listing/user-a/sku-a/request-a.jpg",
  contentType: "image/jpeg",
  sizeBytes: 123,
  expiresAt: new Date("2026-08-01T00:00:00.000Z"),
  completedAt: null,
};
test("legacy listing object keys are server owned and sanitized", () => {
  const key = buildLegacyListingUploadObjectKey(
    "00000000-0000-4000-8000-000000000001",
    {
      sku: " A/B \u5546\u54C1 001 ",
      filename: "../../photo.PNG",
      requestId: "00000000-0000-4000-8000-000000000002",
    },
  );
  assert.equal(
    key,
    "legacy-listing/00000000-0000-4000-8000-000000000001/A_B_\u5546\u54C1_001/00000000-0000-4000-8000-000000000002.png",
  );
});
test("legacy listing complete record derives public URL from server object key", () => {
  assert.deepEqual(legacyListingUploadCompleteRecord("user-a", activeGrant), {
    userId: "user-a",
    sku: "sku-a",
    sourceFilename: "image.jpg",
    objectKey: "legacy-listing/user-a/sku-a/request-a.jpg",
    publicUrl: publicUrlForObjectKey(
      "legacy-listing/user-a/sku-a/request-a.jpg",
    ),
    contentType: "image/jpeg",
    sizeBytes: 123,
  });
});
test("legacy listing grant validation rejects missing expired and wrong-user grants", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");
  assert.deepEqual(validateLegacyListingUploadGrant("user-a", null, now), {
    ok: false,
    status: 404,
    code: "LEGACY_LISTING_UPLOAD_GRANT_NOT_FOUND",
  });
  assert.deepEqual(
    validateLegacyListingUploadGrant("user-b", activeGrant, now),
    { ok: false, status: 403, code: "LEGACY_LISTING_UPLOAD_GRANT_FORBIDDEN" },
  );
  assert.deepEqual(
    validateLegacyListingUploadGrant(
      "user-a",
      { ...activeGrant, expiresAt: new Date("2026-07-30T00:00:00.000Z") },
      now,
    ),
    { ok: false, status: 410, code: "LEGACY_LISTING_UPLOAD_GRANT_EXPIRED" },
  );
});
test("legacy listing completed grant remains idempotently valid after expiration", () => {
  assert.deepEqual(
    validateLegacyListingUploadGrant(
      "user-a",
      {
        ...activeGrant,
        expiresAt: new Date("2026-07-30T00:00:00.000Z"),
        completedAt: new Date("2026-07-29T00:00:00.000Z"),
      },
      new Date("2026-07-31T00:00:00.000Z"),
    ),
    { ok: true, completed: true },
  );
});
test("legacy listing metadata validation rejects size and content-type mismatch", () => {
  assert.deepEqual(
    validateLegacyListingUploadObjectMetadata(activeGrant, null),
    { ok: false, status: 404, code: "LEGACY_LISTING_OBJECT_NOT_FOUND" },
  );
  assert.deepEqual(
    validateLegacyListingUploadObjectMetadata(activeGrant, {
      contentType: "image/png",
      sizeBytes: 123,
    }),
    { ok: false, status: 409, code: "LEGACY_LISTING_OBJECT_METADATA_MISMATCH" },
  );
  assert.deepEqual(
    validateLegacyListingUploadObjectMetadata(activeGrant, {
      contentType: "image/jpeg",
      sizeBytes: 124,
    }),
    { ok: false, status: 409, code: "LEGACY_LISTING_OBJECT_METADATA_MISMATCH" },
  );
  assert.deepEqual(
    validateLegacyListingUploadObjectMetadata(activeGrant, {
      contentType: "image/jpeg; charset=utf-8",
      sizeBytes: 123,
    }),
    { ok: true },
  );
});
test("legacy listing storage uses a separate 50 GB quota", () => {
  const usage = legacyListingStorageUsageTotals({
    galleryBytes: 50 * 1024 ** 3,
    confirmedLegacyBytes: 10 * 1024 ** 3,
    reservedLegacyBytes: 2 * 1024 ** 3,
  });
  assert.equal(usage.usedBytes, 12 * 1024 ** 3);
  assert.equal(legacyListingStorageLimitBytes({}), 50 * 1024 ** 3);
  assert.equal(
    legacyListingStorageLimitBytes({ LEGACY_LISTING_STORAGE_LIMIT_GB: "60" }),
    60 * 1024 ** 3,
  );
  assert.deepEqual(
    validateLegacyListingUploadQuota(
      { limitBytes: legacyListingStorageLimitBytes({}), usedBytes: usage.usedBytes },
      38 * 1024 ** 3,
    ),
    { ok: true },
  );
});
test("legacy listing storage totals include reserved active grants once", () => {
  assert.equal(
    legacyListingStorageUsageTotals({
      galleryBytes: 100,
      confirmedLegacyBytes: 20,
      reservedLegacyBytes: 30,
    }).usedBytes,
    50,
  );
  assert.deepEqual(
    validateLegacyListingUploadQuota({ limitBytes: 200, usedBytes: 150 }, 50),
    { ok: true },
  );
  assert.deepEqual(
    validateLegacyListingUploadQuota({ limitBytes: 200, usedBytes: 151 }, 50),
    { ok: false, code: "GALLERY_STORAGE_LIMIT_EXCEEDED" },
  );
  assert.deepEqual(
    validateLegacyListingUploadQuota({ limitBytes: 0, usedBytes: 1e4 }, 50),
    { ok: true },
  );
});
test("legacy listing complete body rejects client supplied metadata", () => {
  assert.deepEqual(
    parseLegacyListingCompleteBody({
      objectKey: "legacy-listing/user-a/sku-a/request-a.jpg",
    }),
    { objectKey: "legacy-listing/user-a/sku-a/request-a.jpg" },
  );
  assert.throws(
    () =>
      parseLegacyListingCompleteBody({
        objectKey: "legacy-listing/user-a/sku-a/request-a.jpg",
        publicUrl: "https://client.example.com/evil.jpg",
      }),
    /Unrecognized key/,
  );
});
