import { describe, expect, it } from "vitest";
import type { OzonProductRow } from "@shared/types";
import { selectInventoryProducts } from "./inventoryUtils";

const products: OzonProductRow[] = [
  { productId: 1, offerId: "SKU-1", name: "商品 1" },
  { productId: 2, offerId: "SKU-2", name: "商品 2" },
  { offerId: "SKU-3", name: "商品 3" },
];

describe("Ozon inventory utilities", () => {
  it("uses the whole current list when nothing is selected", () => {
    expect(selectInventoryProducts(products, [])).toEqual(products);
  });

  it("uses only selected products when the user checked rows", () => {
    expect(selectInventoryProducts(products, [2, 999])).toEqual([products[1]]);
  });
});
