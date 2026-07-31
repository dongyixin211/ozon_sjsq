import type { CloudAutoListingPlan, Shop, TemplateSummary, WarehouseOption } from '@shared/types';

export type AutoListingPlanDraft = Omit<CloudAutoListingPlan, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

export type AutoListingPlanValidationContext = {
  productTemplates: Array<{ id: string; externalShopId?: string; shared?: boolean }>;
  localTemplates: TemplateSummary[];
  localShops: Shop[];
  warehousesByShopId: Record<string, WarehouseOption[]>;
  warehouseLoadFailedShopIds: string[];
};

export function validateAutoListingPlanDraft(
  draft: AutoListingPlanDraft,
  context?: AutoListingPlanValidationContext,
): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('请输入方案名称');
  if (!draft.productImageRuleId) errors.push('请选择商品类型');
  if (!draft.mockupTemplateId) errors.push('请选择样机模板');
  if (!draft.titlePrompt.trim()) errors.push('请选择或填写标题提示词');
  if (draft.shopConfigs.length === 0) errors.push('请至少选择一个店铺');
  for (const shop of draft.shopConfigs) {
    if (!shop.productTemplateId) {
      errors.push(`${shop.shopName} 缺少商品模板`);
    } else if (context && !context.productTemplates.some((template) => (
      template.id === shop.productTemplateId
      && (template.shared || !template.externalShopId || template.externalShopId === shop.externalShopId)
    ))) {
      errors.push(`${shop.shopName} 商品模板已失效，请重新选择`);
    }

    const localTemplate = context?.localTemplates.find((template) => template.id === shop.localTemplateId);
    if (!shop.localTemplateId) {
      errors.push(`${shop.shopName} 缺少本地执行模板`);
    } else if (context && !localTemplate) {
      errors.push(`${shop.shopName} 本地执行模板已失效，请重新选择`);
    } else if (!isValidTemplateProduct(localTemplate?.payload ?? shop.templateProduct)) {
      errors.push(`${shop.shopName} 本地执行模板内容无效，请重新选择`);
    }

    if (!context || !draft.enabled) continue;
    const localShop = context.localShops.find((candidate) => candidate.id === shop.localShopId)
      ?? context.localShops.find((candidate) => candidate.id === shop.externalShopId);
    if (!localShop) {
      errors.push(`${shop.shopName} 本地店铺配置缺失`);
    } else {
      if (!localShop.enabled) errors.push(`${shop.shopName} 已停用`);
      if (!localShop.clientId.trim()) errors.push(`${shop.shopName} 缺少 Ozon Client ID`);
      if (!localShop.apiKeyStored) errors.push(`${shop.shopName} 缺少 Ozon API Key`);
    }

    if (shop.autoUpdateStock && localTemplate) {
      const warehouseId = getTemplateWarehouseId(localTemplate.payload);
      if (!warehouseId) {
        errors.push(`${shop.shopName} 本地执行模板未配置仓库`);
      } else if (context.warehouseLoadFailedShopIds.includes(shop.localShopId)) {
        errors.push(`${shop.shopName} 仓库加载失败，请检查本地助手连接`);
      } else if (!(context.warehousesByShopId[shop.localShopId] ?? []).some((warehouse) => warehouse.warehouseId === warehouseId)) {
        errors.push(`${shop.shopName} 本地执行模板配置的仓库不可用`);
      }
    }
  }
  if (!Number.isInteger(draft.batchSize) || draft.batchSize < 5 || draft.batchSize > 20) {
    errors.push('单批数量必须在 5–20 之间');
  }
  if (!Number.isInteger(draft.bufferSize) || draft.bufferSize < 0) {
    errors.push('滚动缓冲必须是非负整数');
  } else if (draft.bufferSize > draft.batchSize * 2) {
    errors.push('滚动缓冲不能超过两个批次');
  }
  if (draft.startMinute < 0 || draft.startMinute >= 24 * 60 || draft.endMinute <= 0 || draft.endMinute > 24 * 60) {
    errors.push('执行时段无效');
  }
  if (draft.startMinute >= draft.endMinute) errors.push('执行开始时间必须早于结束时间');
  return errors;
}

export function getTemplateWarehouseId(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const warehouseId = Number(payload.warehouse_id ?? payload.warehouseId);
  return Number.isInteger(warehouseId) && warehouseId > 0 ? warehouseId : null;
}

export function autoListingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const normalized = `${code} ${message}`.toLowerCase();
  if (normalized.includes('enabled plan already exists')) {
    return '该商品类型已有启用方案，请先编辑或停用原方案';
  }
  if (normalized.includes('auto_listing_plan_not_found') || normalized.includes('automatic listing plan not found')) {
    return '自动上品方案不存在或已被删除';
  }
  if (normalized.includes('execution window is invalid')) return '执行时段无效，请重新设置';
  if (normalized.includes('duplicate shop')) return '同一方案不能重复选择店铺';
  if (normalized.includes('membership_required')) return '当前账号无权使用自动上品方案';
  if (normalized.includes('unauthorized') || normalized.includes('auth_required')) return '登录已失效，请重新登录';
  if (/[^\x00-\x7F]/.test(message)) return message.replace(/^Error:\s*/, '');
  return '自动上品云端请求失败，请稍后重试';
}

function isValidTemplateProduct(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).length > 0;
}

export function formatMinuteOfDay(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function parseMinuteOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}
