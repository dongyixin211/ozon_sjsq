export type AutoListingShopProgressInput = {
  externalShopId: string;
  shopName: string;
  limit: number;
  listedCount: number;
  pendingCount: number;
  reservedCount: number;
  failedCount: number;
};

export type AutoListingShopSummary = AutoListingShopProgressInput & {
  completed: number;
  processing: number;
  remaining: number;
};

export type AutoListingSummary = {
  title: "自动上架";
  target: number;
  completed: number;
  processing: number;
  failed: number;
  remaining: number;
  shops: AutoListingShopSummary[];
};

function safeNumber(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function buildAutoListingSummary(
  shops: AutoListingShopProgressInput[],
): AutoListingSummary {
  const summaries = shops.map((shop) => {
    const limit = safeNumber(shop.limit);
    const completed = safeNumber(shop.listedCount);
    const processing = safeNumber(shop.pendingCount) + safeNumber(shop.reservedCount);
    return {
      ...shop,
      limit,
      listedCount: completed,
      pendingCount: safeNumber(shop.pendingCount),
      reservedCount: safeNumber(shop.reservedCount),
      failedCount: safeNumber(shop.failedCount),
      completed,
      processing,
      remaining: Math.max(0, limit - completed - processing),
    };
  });
  return {
    title: "自动上架",
    target: summaries.reduce((sum, shop) => sum + shop.limit, 0),
    completed: summaries.reduce((sum, shop) => sum + shop.completed, 0),
    processing: summaries.reduce((sum, shop) => sum + shop.processing, 0),
    failed: summaries.reduce((sum, shop) => sum + shop.failedCount, 0),
    remaining: summaries.reduce((sum, shop) => sum + shop.remaining, 0),
    shops: summaries,
  };
}
