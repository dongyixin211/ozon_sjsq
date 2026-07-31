import type { Shop, TemplateSummary } from "@shared/types";
import type {
  CloudListingPreferenceShopConfig,
  CloudListingPreferences,
  CloudProductTemplate,
  CloudShop,
} from "../../lib/cloudApi";

export type ListingSetupPhase = "loading" | "ready" | "error";

export type ShopListingConfig = {
  externalShopId: string;
  productTemplateId: string;
  productTemplateName: string;
  newTemplateName: string;
  categoryLabel: string;
  productTemplateShared: boolean;
  localTemplateId: string;
  autoGenerateBarcode: boolean;
  autoUpdateStock: boolean;
  autoAddToAction: boolean;
  autoWarehouseId: number | "";
  autoStock: number;
  autoActionId: number | "";
  autoActionPrice: string;
  autoActionStock: number;
  actionDelayMinutes: number;
  actionRetryCount: number;
  actionRetryIntervalMinutes: number;
  dailyListingLimit: number;
};

type ListingShopSource = Pick<CloudShop, "id" | "name"> & Partial<Pick<CloudShop, "externalShopId">>;

type MergeListingShopsInput = {
  cloudShops: ListingShopSource[];
  localShops: Pick<Shop, "id" | "name">[];
  savedConfigs: CloudListingPreferenceShopConfig[];
  currentConfigs: ShopListingConfig[];
};

export type BuildInitialListingSetupInput = {
  cloudShops: ListingShopSource[];
  localShops: Pick<Shop, "id" | "name">[];
  preferences: CloudListingPreferences;
  currentShopListingConfigs: ShopListingConfig[];
  productTemplates: CloudProductTemplate[];
  localProductTemplates: TemplateSummary[];
};

export type ListingSetupSnapshot = {
  shopListingConfigs: ShopListingConfig[];
  productTemplates: CloudProductTemplate[];
  localProductTemplates: TemplateSummary[];
};

export function buildInitialListingSetup(input: BuildInitialListingSetupInput): ListingSetupSnapshot {
  return {
    shopListingConfigs: mergeListingShops({
      cloudShops: input.cloudShops,
      localShops: input.localShops,
      savedConfigs: input.preferences.shopListingConfigs ?? [],
      currentConfigs: input.currentShopListingConfigs,
    }),
    productTemplates: [...input.productTemplates],
    localProductTemplates: [...input.localProductTemplates],
  };
}

export function mergeListingShops(input: MergeListingShopsInput): ShopListingConfig[] {
  const shopsById = new Map<string, string>();
  for (const shop of input.localShops) {
    if (shop.id.trim() && shop.name.trim()) shopsById.set(shop.id, shop.name);
  }
  for (const shop of input.cloudShops) {
    const externalShopId = (shop.externalShopId || shop.id).trim();
    if (externalShopId && shop.name.trim()) shopsById.set(externalShopId, shop.name);
  }

  const savedById = new Map(input.savedConfigs.map((config) => [config.externalShopId, config]));
  const currentById = new Map(input.currentConfigs.map((config) => [config.externalShopId, config]));
  const orderedIds = new Set<string>();
  const hasLoadedShops = shopsById.size > 0;
  input.savedConfigs.forEach((config) => {
    if (!hasLoadedShops || shopsById.has(config.externalShopId)) orderedIds.add(config.externalShopId);
  });
  input.currentConfigs.forEach((config) => {
    if (!hasLoadedShops || shopsById.has(config.externalShopId)) orderedIds.add(config.externalShopId);
  });
  [...shopsById.entries()]
    .sort((left, right) => left[1].localeCompare(right[1], "zh-CN", { numeric: true, sensitivity: "base" }))
    .forEach(([externalShopId]) => orderedIds.add(externalShopId));

  return [...orderedIds].map((externalShopId) => {
    const shopName = shopsById.get(externalShopId) ?? "店铺";
    const saved = savedById.get(externalShopId);
    if (saved) {
      return createShopListingConfigFromPreference(saved, shopName);
    }
    return currentById.get(externalShopId) ?? createDefaultShopListingConfig(externalShopId, shopName);
  });
}

export function createDefaultShopListingConfig(externalShopId: string, shopName: string): ShopListingConfig {
  return {
    externalShopId,
    productTemplateId: "",
    productTemplateName: "",
    newTemplateName: `${shopName}商品模板`,
    categoryLabel: "",
    productTemplateShared: true,
    localTemplateId: "",
    autoGenerateBarcode: false,
    autoUpdateStock: false,
    autoAddToAction: false,
    autoWarehouseId: "",
    autoStock: 50,
    autoActionId: "",
    autoActionPrice: "",
    autoActionStock: 50,
    actionDelayMinutes: 0,
    actionRetryCount: 72,
    actionRetryIntervalMinutes: 10,
    dailyListingLimit: 300,
  };
}

export function createShopListingConfigFromPreference(
  config: CloudListingPreferenceShopConfig,
  shopName: string,
): ShopListingConfig {
  const fallback = createDefaultShopListingConfig(config.externalShopId, shopName);
  return {
    ...fallback,
    productTemplateId: config.productTemplateId ?? fallback.productTemplateId,
    productTemplateName: config.productTemplateName ?? fallback.productTemplateName,
    newTemplateName: config.newTemplateName ?? config.productTemplateName ?? fallback.newTemplateName,
    categoryLabel: config.categoryLabel ?? fallback.categoryLabel,
    productTemplateShared: config.productTemplateShared ?? fallback.productTemplateShared,
    localTemplateId: config.localTemplateId ?? fallback.localTemplateId,
    autoGenerateBarcode: config.autoGenerateBarcode ?? fallback.autoGenerateBarcode,
    autoUpdateStock: config.autoUpdateStock ?? fallback.autoUpdateStock,
    autoAddToAction: config.autoAddToAction ?? fallback.autoAddToAction,
    autoWarehouseId: config.autoWarehouseId ?? fallback.autoWarehouseId,
    autoStock: config.autoStock ?? fallback.autoStock,
    autoActionId: config.autoActionId ?? fallback.autoActionId,
    autoActionPrice: config.autoActionPrice ?? fallback.autoActionPrice,
    autoActionStock: config.autoActionStock ?? fallback.autoActionStock,
    actionDelayMinutes: config.actionDelayMinutes ?? fallback.actionDelayMinutes,
    actionRetryCount: config.actionRetryCount ?? fallback.actionRetryCount,
    actionRetryIntervalMinutes: config.actionRetryIntervalMinutes ?? fallback.actionRetryIntervalMinutes,
    dailyListingLimit: config.dailyListingLimit ?? fallback.dailyListingLimit,
  };
}
