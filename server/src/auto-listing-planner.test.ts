import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateRoundRobin,
  assertAssignmentBatchUpdate,
  calculateRemainingShopCapacity,
  calculateAvailableReservationSlots,
  calculateSafeCreateCount,
  canReleaseAssignment,
  assertAssignmentStatusTransition,
  validateAutoListingPlan,
  validateAutoListingLaunch,
  shouldReleaseFailedAssignment,
} from "./auto-listing-planner.js";

test("uses the full live create quota unless a reserve is requested", () => {
  assert.equal(calculateSafeCreateCount({ createRemaining: 100, totalRemaining: 500 }, 1000), 100);
  assert.equal(calculateSafeCreateCount({ createRemaining: 100, totalRemaining: 500 }, 1000, 0.05), 95);
  assert.equal(calculateSafeCreateCount({ createRemaining: 2, totalRemaining: 500 }, 1000), 2);
  assert.equal(calculateSafeCreateCount({ createRemaining: 100, totalRemaining: 3 }, 1000), 3);
  assert.equal(calculateSafeCreateCount({ createRemaining: 100, totalRemaining: 500 }, 2), 2);
});

test("limits a shop by daily target, completed items, outstanding items, and live quota", () => {
  assert.equal(calculateRemainingShopCapacity({ createRemaining: 100, totalRemaining: 500 }, 100, 0, 10, 30), 30);
  assert.equal(calculateRemainingShopCapacity({ createRemaining: 100, totalRemaining: 500 }, 100, 40, 10, 15), 15);
  assert.equal(calculateRemainingShopCapacity({ createRemaining: 4, totalRemaining: 500 }, 100, 0, 0, 30), 4);
});

test("reservation window is applied independently to every shop", () => {
  const shops = Array.from({ length: 12 }, (_, index) => ({
    externalShopId: String(index + 1),
    capacity: 100,
    outstanding: 0,
  }));
  assert.equal(calculateAvailableReservationSlots(shops, 30), 360);
  assert.equal(
    calculateAvailableReservationSlots([
      { externalShopId: "A", capacity: 100, outstanding: 25 },
      { externalShopId: "B", capacity: 4, outstanding: 0 },
    ], 30),
    9,
  );
});

test("counts reservation slots per shop instead of as one global window", () => {
  const shops = [
    { externalShopId: "A", capacity: 100, outstanding: 0 },
    { externalShopId: "B", capacity: 100, outstanding: 20 },
  ];
  assert.equal(calculateAvailableReservationSlots(shops, 30), 40);
});

test("round robin redistributes after a shop reaches quota", () => {
  const result = allocateRoundRobin([
    { externalShopId: "A", capacity: 1 },
    { externalShopId: "B", capacity: 3 },
  ], ["1", "2", "3", "4"]);
  assert.deepEqual(result.map((item) => item.externalShopId), ["A", "B", "B", "B"]);
  assert.deepEqual(result.map((item) => item.assetId), ["1", "2", "3", "4"]);
});

test("round robin fills the least outstanding shop first", () => {
  const result = allocateRoundRobin([
    { externalShopId: "A", capacity: 10, outstanding: 10 },
    { externalShopId: "B", capacity: 10, outstanding: 0 },
  ], ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.deepEqual(result.map((item) => item.externalShopId), [
    "B", "B", "B", "B", "B", "B", "B", "B", "B", "B",
  ]);
});

test("reports missing shop quota before automatic listing starts", () => {
  const result = validateAutoListingLaunch(
    [
      { externalShopId: "shop-a", shopName: "?? A" },
      { externalShopId: "shop-b", shopName: "?? B" },
    ],
    { "shop-a": { dailyCreateRemaining: 100, totalRemaining: 100 } },
  );
  assert.deepEqual(result, {
    ok: false,
    issues: [{ externalShopId: "shop-b", shopName: "?? B", reason: "quota_missing" }],
  });
});

test("rejects duplicate asset identifiers", () => {
  assert.throws(
    () => allocateRoundRobin([{ externalShopId: "A", capacity: 2 }], ["1", "1"]),
    /duplicate asset id/i,
  );
});

test("releases terminal failures so the next reservation can refill them", () => {
  assert.equal(shouldReleaseFailedAssignment("failed", 2), false);
  assert.equal(shouldReleaseFailedAssignment("failed", 3), true);
  assert.equal(shouldReleaseFailedAssignment("preparing", 3), false);
});

test("only untouched reserved assignments can be released", () => {
  assert.equal(canReleaseAssignment({ status: "reserved", batchId: null, hasGeneratedWork: false }), true);
  assert.equal(canReleaseAssignment({ status: "reserved", batchId: "batch", hasGeneratedWork: false }), false);
  assert.equal(canReleaseAssignment({ status: "preparing", batchId: null, hasGeneratedWork: false }), false);
  assert.equal(canReleaseAssignment({ status: "reserved", batchId: null, hasGeneratedWork: true }), false);
});

const validPlan = {
  startMinute: 480,
  endMinute: 1320,
  batchSize: 10,
  bufferSize: 20,
  enabled: true,
  externalShopIds: ["shop-a", "shop-b"],
};

test("rejects execution windows whose start is not earlier than end", () => {
  assert.throws(
    () => validateAutoListingPlan({ ...validPlan, startMinute: 1320, endMinute: 480 }, false),
    /execution window/i,
  );
});

test("rejects plan batch sizes outside 5 through 20", () => {
  assert.throws(
    () => validateAutoListingPlan({ ...validPlan, batchSize: 21 }, false),
    /batch size/i,
  );
});

test("rejects plan buffers larger than two batches", () => {
  assert.throws(
    () => validateAutoListingPlan({ ...validPlan, bufferSize: 21 }, false),
    /buffer size/i,
  );
});

test("rejects duplicate shops in a plan snapshot", () => {
  assert.throws(
    () => validateAutoListingPlan({ ...validPlan, externalShopIds: ["shop-a", "shop-a"] }, false),
    /duplicate shop/i,
  );
});

test("rejects enabling a second plan for one product rule", () => {
  assert.throws(
    () => validateAutoListingPlan(validPlan, true),
    /enabled plan/i,
  );
});

test("rejects enabled plans without shops", () => {
  assert.throws(
    () => validateAutoListingPlan({ ...validPlan, externalShopIds: [] }, false),
    /enabled plan.*shop/i,
  );
});

test("permits forward assignment progress and guarded recovery", () => {
  assert.doesNotThrow(() => assertAssignmentStatusTransition("reserved", "preparing"));
  assert.doesNotThrow(() => assertAssignmentStatusTransition("preparing", "ready"));
  assert.doesNotThrow(() => assertAssignmentStatusTransition("ready", "submitting"));
  assert.doesNotThrow(() => assertAssignmentStatusTransition("submitting", "completed"));
  assert.doesNotThrow(() => assertAssignmentStatusTransition("failed", "preparing"));
  assert.doesNotThrow(() => assertAssignmentStatusTransition("paused", "preparing"));
});

test("rejects skipped and terminal assignment transitions", () => {
  assert.throws(() => assertAssignmentStatusTransition("reserved", "completed"), /transition/i);
  assert.throws(() => assertAssignmentStatusTransition("completed", "preparing"), /transition/i);
  assert.throws(() => assertAssignmentStatusTransition("released", "reserved"), /transition/i);
});

test("keeps an assignment bound to its first listing batch", () => {
  assert.doesNotThrow(() => assertAssignmentBatchUpdate(null, "batch-a"));
  assert.doesNotThrow(() => assertAssignmentBatchUpdate("batch-a", "batch-a"));
  assert.throws(() => assertAssignmentBatchUpdate("batch-a", null), /batch/i);
  assert.throws(() => assertAssignmentBatchUpdate("batch-a", "batch-b"), /batch/i);
});


