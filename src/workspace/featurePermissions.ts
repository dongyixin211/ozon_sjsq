/**
 * featurePermissions.ts — 页面权限映射与菜单过滤
 *
 * 将前端 PageKey 映射到后端 feature_flags.key，
 * 根据用户 features 数组过滤可见的菜单项。
 */

import type { PageKey, WorkspaceModule } from "./navigation";

// ============================================================
// 页面 → 功能标识映射
// 没有 featureKey 的页面默认所有角色可见
// ============================================================

export const PAGE_FEATURE_MAP: Partial<Record<PageKey, string>> = {
  // 素材模块 - 测试中功能
  imageUpload: "gallery.upload",
  imagePending: "gallery.pending",
  imageProcessing: "gallery.processing",
  imageUploaded: "gallery.uploaded",
  imageFeatured: "gallery.featured",
  // 上架模块 - 测试中功能
  autoListingPlans: "listing.auto_plans",
  // 管理后台 - 仅 admin 可见
  adminUsers: "admin.panel",
  adminFeatures: "admin.panel",
  adminLogs: "admin.panel",
};

// ============================================================
// 权限判断
// ============================================================

/** 检查用户是否拥有某个功能的访问权限 */
export function hasFeature(features: Set<string>, featureKey: string): boolean {
  if (features.has("*")) return true;
  return features.has(featureKey);
}

/** 检查用户是否可以访问某个页面 */
export function canAccessPage(features: Set<string>, pageKey: PageKey): boolean {
  const featureKey = PAGE_FEATURE_MAP[pageKey];
  if (!featureKey) return true; // 无 featureKey 的页面默认可见
  return hasFeature(features, featureKey);
}

// ============================================================
// 菜单过滤
// ============================================================

/**
 * 根据用户 features 过滤模块和页面
 * 过滤掉用户无权访问的页面，以及所有页面都被过滤掉的空模块
 */
export function filterModulesByFeatures(
  modules: readonly WorkspaceModule[],
  features: Set<string>,
): WorkspaceModule[] {
  // admin 拥有全部权限
  if (features.has("*")) return [...modules];

  return modules
    .map((mod) => ({
      ...mod,
      pages: mod.pages.filter((page) => canAccessPage(features, page.key)),
    }))
    .filter((mod) => mod.pages.length > 0); // 过滤掉空模块
}
