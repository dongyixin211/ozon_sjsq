export const autoListingText = {
  title: "自动上架",
  onlyPending: "只有待上传图片可以自动上架",
  setupLoading: "店铺模板和上架配置还在加载中，请稍等",
  selectImages: "请先选择要自动上架的图片",
  selectProductRule: "请先选择商品类型和图片比例",
  addShop: "请先添加要上架的店铺",
  completeShop: "请先为店铺选择或填写商品模板",
  syncLocalShop: "请先在本地助手同步店铺",
  selectLocalTemplate: "请先为店铺选择本地 Ozon 商品模板",
  quotaQueryFailed: "额度查询失败，提交时服务器会最终校验",
  quotaInsufficient: "额度不足",
} as const;

type DisabledReasonInput = {
  isPending: boolean;
  selectedCount: number;
  productImageRuleId: string;
  shopCount: number;
  setupLoaded: boolean;
  hasIncompleteShop: boolean;
  hasMissingLocalTemplate: boolean;
  localShopCount: number;
};

export function getAutoListingDisabledReason(input: DisabledReasonInput) {
  if (!input.isPending) return autoListingText.onlyPending;
  if (!input.setupLoaded) return autoListingText.setupLoading;
  if (input.selectedCount === 0) return autoListingText.selectImages;
  if (!input.productImageRuleId) return autoListingText.selectProductRule;
  if (input.shopCount === 0) return autoListingText.addShop;
  if (input.hasIncompleteShop) return autoListingText.completeShop;
  if (input.localShopCount === 0) return autoListingText.syncLocalShop;
  if (input.hasMissingLocalTemplate) return autoListingText.selectLocalTemplate;
  return "";
}
