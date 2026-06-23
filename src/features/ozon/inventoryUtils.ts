import type { OzonProductRow } from "@shared/types";

export function selectInventoryProducts(
  products: OzonProductRow[],
  selectedProductIds: number[],
): OzonProductRow[] {
  if (selectedProductIds.length === 0) return products;
  const selected = new Set(selectedProductIds);
  return products.filter((product) =>
    typeof product.productId === "number" && selected.has(product.productId)
  );
}
