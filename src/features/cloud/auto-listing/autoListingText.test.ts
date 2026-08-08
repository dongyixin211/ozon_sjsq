import { describe, expect, it } from "vitest";
import { autoListingText, getAutoListingDisabledReason } from "./autoListingText";

describe("automatic listing copy", () => {
  it("contains readable Chinese text for the configuration page", () => {
    expect(autoListingText.title).toBe("自动上架");
    expect(autoListingText.addShop).toBe("请先添加要上架的店铺");
    expect(Object.values(autoListingText).every((value) => !value.includes("�"))).toBe(true);
  });

  it("explains missing setup instead of returning an empty message", () => {
    expect(getAutoListingDisabledReason({
      isPending: true,
      selectedCount: 1,
      productImageRuleId: "rule",
      shopCount: 0,
      setupLoaded: true,
      hasIncompleteShop: false,
      hasMissingLocalTemplate: false,
      localShopCount: 0,
    })).toBe("请先添加要上架的店铺");
  });
});
