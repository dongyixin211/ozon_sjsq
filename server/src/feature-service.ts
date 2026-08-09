/**
 * feature-service.ts — RBAC 功能权限计算与缓存
 *
 * 职责：
 * 1. 缓存 feature_flags 表数据（60s TTL）
 * 2. 计算用户的 features 数组（admin=[*], beta=全部活跃, member=角色默认+个人授权）
 * 3. 判断用户是否拥有某个功能的访问权限
 */

import { pool } from "./db.js";

// ============================================================
// 类型
// ============================================================

export interface FeatureFlag {
  key: string;
  label: string;
  module: string;
  description: string | null;
  defaultRoles: string[];
  isActive: boolean;
  sortOrder: number;
}

// ============================================================
// 缓存
// ============================================================

let featureFlagsCache: FeatureFlag[] | null = null;
let featureFlagsCacheAt = 0;
const FEATURE_FLAGS_CACHE_TTL_MS = 60_000; // 1 分钟

/** 获取所有活跃的功能标识（带缓存） */
export async function getActiveFeatureFlags(): Promise<FeatureFlag[]> {
  const now = Date.now();
  if (featureFlagsCache && now - featureFlagsCacheAt < FEATURE_FLAGS_CACHE_TTL_MS) {
    return featureFlagsCache;
  }

  const result = await pool.query<{
    key: string;
    label: string;
    module: string;
    description: string | null;
    default_roles: string[];
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT key, label, module, description, default_roles, is_active, sort_order
     FROM feature_flags
     WHERE is_active = true
     ORDER BY sort_order`,
  );

  featureFlagsCache = result.rows.map((row) => ({
    key: row.key,
    label: row.label,
    module: row.module,
    description: row.description,
    defaultRoles: row.default_roles,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  }));
  featureFlagsCacheAt = now;
  return featureFlagsCache;
}

/** 获取单个功能标识（带缓存） */
export async function getFeatureFlag(featureKey: string): Promise<FeatureFlag | null> {
  const flags = await getActiveFeatureFlags();
  return flags.find((f) => f.key === featureKey) ?? null;
}

/** 清除缓存（管理操作后调用） */
export function invalidateFeatureFlagsCache(): void {
  featureFlagsCache = null;
  featureFlagsCacheAt = 0;
}

// ============================================================
// 权限计算
// ============================================================

/**
 * 计算用户的 features 数组
 * - admin: 返回 ["*"]（全部功能）
 * - beta: 返回所有活跃的 feature keys
 * - member: 返回角色默认权限 + 个人授权的并集
 */
export async function computeUserFeatures(
  userId: string,
  roles: string[],
): Promise<string[]> {
  // admin 拥有全部权限
  if (roles.includes("admin")) {
    return ["*"];
  }

  const flags = await getActiveFeatureFlags();
  const features = new Set<string>();

  // 角色默认权限
  for (const flag of flags) {
    if (roles.some((role) => flag.defaultRoles.includes(role))) {
      features.add(flag.key);
    }
  }

  // member 用户还检查个人授权
  if (roles.includes("member")) {
    const accessResult = await pool.query<{ feature_key: string }>(
      `SELECT feature_key FROM user_feature_access
       WHERE user_id = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    );
    for (const row of accessResult.rows) {
      features.add(row.feature_key);
    }
  }

  return [...features];
}

/**
 * 判断用户是否拥有某个功能的访问权限
 * 用于 requireFeature 中间件
 */
export async function hasFeatureAccess(
  userId: string,
  roles: string[],
  featureKey: string,
): Promise<boolean> {
  // admin 始终放行
  if (roles.includes("admin")) return true;

  const flag = await getFeatureFlag(featureKey);
  if (!flag) return false;

  // 角色默认权限
  if (roles.some((role) => flag.defaultRoles.includes(role))) return true;

  // member 个人授权
  if (roles.includes("member")) {
    const accessResult = await pool.query<{ feature_key: string }>(
      `SELECT 1 FROM user_feature_access
       WHERE user_id = $1 AND feature_key = $2
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [userId, featureKey],
    );
    return accessResult.rows.length > 0;
  }

  return false;
}
