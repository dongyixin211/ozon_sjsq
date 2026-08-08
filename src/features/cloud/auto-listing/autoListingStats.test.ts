import { describe, expect, it } from "vitest";
import { autoListingText, getAutoListingDisabledReason } from "./autoListingText";
import { buildAutoListingSummary } from "./autoListingStats";

describe("auto listing text", () => {
  it("returns readable Chinese disabled reasons", () => {
    expect(getAutoListingDisabledReason({
      isPending: true,
      selectedCount: 0,
      productImageRuleId: "rule",
      shopCount: 1,
      setupLoaded: true,
      hasIncompleteShop: false,
      hasMissingLocalTemplate: false,
      localShopCount: 1,
    })).toBe("请先选择要自动上架的图片");
    expect(autoListingText.title).toBe("自动上架");
    expect(autoListingText.title).not.toContain("�");
  });
});

describe("buildAutoListingSummary", () => {
  it("calculates total and per-shop remaining progress", () => {
    const summary = buildAutoListingSummary([
      { externalShopId: "shop-a", shopName: "店铺 A", limit: 100, listedCount: 20, pendingCount: 10, reservedCount: 5, failedCount: 2 },
      { externalShopId: "shop-b", shopName: "店铺 B", limit: 80, listedCount: 30, pendingCount: 0, reservedCount: 0, failedCount: 0 },
    ]);
    expect(summary.target).toBe(180);
    expect(summary.completed).toBe(50);
    expect(summary.processing).toBe(15);
    expect(summary.failed).toBe(2);
    expect(summary.remaining).toBe(115);
    expect(summary.shops[0]).toMatchObject({ shopName: "店铺 A", remaining: 65 });
  });
});
