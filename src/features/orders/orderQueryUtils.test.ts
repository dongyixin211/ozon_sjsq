import { describe, expect, it } from "vitest";
import { isLatestOrderRequest, resolveStoredOrderQuery } from "./orderQueryUtils";

describe("resolveStoredOrderQuery", () => {
  it("treats an explicit empty status as all statuses", () => {
    expect(resolveStoredOrderQuery({
      currentStatus: "awaiting_packaging",
      status: "",
      shopIds: ["shop-a"],
      keyword: " SKU-001 ",
      limit: 25,
    })).toEqual({
      shopIds: ["shop-a"],
      status: undefined,
      keyword: "SKU-001",
      limit: 25,
    });
  });

  it("uses the current status when no override is present", () => {
    expect(resolveStoredOrderQuery({
      currentStatus: "awaiting_packaging",
      shopIds: ["shop-a"],
      keyword: "",
      limit: 1000,
    })).toEqual({
      shopIds: ["shop-a"],
      status: "awaiting_packaging",
      keyword: undefined,
      limit: 1000,
    });
  });
});

describe("isLatestOrderRequest", () => {
  it("only accepts the current request id", () => {
    expect(isLatestOrderRequest(2, 2)).toBe(true);
    expect(isLatestOrderRequest(1, 2)).toBe(false);
  });
});
