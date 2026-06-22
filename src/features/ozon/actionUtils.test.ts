import { describe, expect, it } from "vitest";
import { buildActionProductPayload, discountPercent, extractNextLastId, moneyNumber } from "./actionUtils";

describe("Ozon action utilities", () => {
  it("builds activate payload from candidate product", () => {
    expect(buildActionProductPayload({
      productId: 123,
      offerId: "SKU-1",
      price: "1000",
      actionPrice: "800",
    }, "", 10)).toEqual({
      product_id: 123,
      action_price: "800",
      stock: 10,
      discount: 20,
    });
  });

  it("lets a typed unified action price override candidate price", () => {
    expect(buildActionProductPayload({
      productId: 123,
      offerId: "SKU-1",
      price: "1 000,50",
      actionPrice: "900",
    }, "700", 5)).toEqual({
      product_id: 123,
      action_price: "700",
      stock: 5,
      discount: 30,
    });
  });

  it("preserves explicit discount from Ozon candidate response", () => {
    expect(buildActionProductPayload({
      productId: 123,
      price: "1000",
      actionPrice: "800",
      discount: 15,
    }, "", 10)).toMatchObject({ discount: 15 });
  });

  it("rejects candidates without product id or price", () => {
    expect(() => buildActionProductPayload({ offerId: "SKU-1", actionPrice: "800" }, "", 10)).toThrow("缺少商品 ID");
    expect(() => buildActionProductPayload({ productId: 123, offerId: "SKU-1" }, "", 10)).toThrow("缺少活动价");
  });

  it("normalizes money and clamps discount", () => {
    expect(moneyNumber("1 234,50")).toBe(1234.5);
    expect(discountPercent("1000", "999")).toBe(1);
    expect(discountPercent("1000", "1")).toBe(99);
    expect(discountPercent("1000", "1200")).toBeUndefined();
  });

  it("extracts last_id from Ozon pagination shapes", () => {
    expect(extractNextLastId({ result: { last_id: "next" } })).toBe("next");
    expect(extractNextLastId({ result: { lastId: "camel" } })).toBe("camel");
    expect(extractNextLastId({ last_id: "top" })).toBe("top");
    expect(extractNextLastId({})).toBe("");
  });
});
