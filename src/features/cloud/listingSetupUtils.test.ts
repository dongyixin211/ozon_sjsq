import { describe, expect, it } from "vitest";
import type { CloudListingPreferences, CloudProductTemplate } from "../../lib/cloudApi";
import type { TemplateSummary } from "@shared/types";
import { buildInitialListingSetup, mergeListingShops } from "./listingSetupUtils";

const savedPreferences: CloudListingPreferences = {
  shopListingConfigs: [{
    externalShopId: "shop-a",
    productTemplateId: "cloud-template-a",
    productTemplateName: "Saved cloud template",
    newTemplateName: "Saved cloud template",
    categoryLabel: "Scarves",
    productTemplateShared: false,
    localTemplateId: "local-template-a",
    autoGenerateBarcode: true,
    autoUpdateStock: true,
    autoStock: 25,
  }],
};

const cloudShops = [{ id: "cloud-shop-a", externalShopId: "shop-a", name: "Shop A" }];
const localShops = [{ id: "shop-b", name: "Shop B" }];

describe("listing setup initialization", () => {
  it("produces the same shop configs when preferences or shops arrive first", () => {
    const preferencesFirst = buildInitialListingSetup({
      cloudShops: [],
      localShops: [],
      preferences: savedPreferences,
      currentShopListingConfigs: [],
      productTemplates: [],
      localProductTemplates: [],
    });
    const preferencesThenShops = buildInitialListingSetup({
      cloudShops,
      localShops,
      preferences: savedPreferences,
      currentShopListingConfigs: preferencesFirst.shopListingConfigs,
      productTemplates: [],
      localProductTemplates: [],
    });

    const shopsFirst = buildInitialListingSetup({
      cloudShops,
      localShops,
      preferences: {},
      currentShopListingConfigs: [],
      productTemplates: [],
      localProductTemplates: [],
    });
    const shopsThenPreferences = buildInitialListingSetup({
      cloudShops,
      localShops,
      preferences: savedPreferences,
      currentShopListingConfigs: shopsFirst.shopListingConfigs,
      productTemplates: [],
      localProductTemplates: [],
    });

    expect(preferencesThenShops.shopListingConfigs).toEqual(shopsThenPreferences.shopListingConfigs);
    expect(preferencesThenShops.shopListingConfigs).toEqual([
      expect.objectContaining({
        externalShopId: "shop-a",
        productTemplateId: "cloud-template-a",
        productTemplateName: "Saved cloud template",
        productTemplateShared: false,
        localTemplateId: "local-template-a",
      }),
      expect.objectContaining({ externalShopId: "shop-b", productTemplateId: "", localTemplateId: "" }),
    ]);
  });

  it("preserves saved configs and template arrays when sources are temporarily incomplete", () => {
    const productTemplates = Array.from({ length: 12 }, (_, index): CloudProductTemplate => ({
      id: `cloud-template-${index}`,
      externalShopId: index % 2 === 0 ? "shop-a" : "shop-other",
      shopName: index % 2 === 0 ? "Shop A" : "Other shop",
      shared: index < 3,
      name: `Cloud template ${index}`,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    }));
    const localProductTemplates = Array.from({ length: 11 }, (_, index): TemplateSummary => ({
      id: `local-template-${index}`,
      kind: "product_import",
      name: `Local template ${index}`,
      payload: {},
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    }));

    const result = buildInitialListingSetup({
      cloudShops: [],
      localShops: [],
      preferences: savedPreferences,
      currentShopListingConfigs: [],
      productTemplates,
      localProductTemplates,
    });

    expect(result.shopListingConfigs).toHaveLength(1);
    expect(result.shopListingConfigs[0]).toEqual(expect.objectContaining({
      externalShopId: "shop-a",
      productTemplateId: "cloud-template-a",
      localTemplateId: "local-template-a",
    }));
    expect(result.productTemplates).toHaveLength(12);
    expect(result.localProductTemplates).toHaveLength(11);
  });

  it("keeps current configs when no loaded shop source can validate them yet", () => {
    const current = buildInitialListingSetup({
      cloudShops,
      localShops: [],
      preferences: savedPreferences,
      currentShopListingConfigs: [],
      productTemplates: [],
      localProductTemplates: [],
    }).shopListingConfigs;

    expect(mergeListingShops({
      cloudShops: [],
      localShops: [],
      savedConfigs: [],
      currentConfigs: current,
    })).toEqual(current);
  });

  it("drops stale configs after valid shops have loaded", () => {
    const result = mergeListingShops({
      cloudShops,
      localShops,
      savedConfigs: [{ ...savedPreferences.shopListingConfigs![0], externalShopId: "deleted-shop" }],
      currentConfigs: [],
    });

    expect(result.map((config) => config.externalShopId)).toEqual(["shop-a", "shop-b"]);
  });

});
