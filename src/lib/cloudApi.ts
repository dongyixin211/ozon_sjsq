import type {
  AiSettingsPublic,
  AutoListingAssignmentStatus,
  CloudAutoListingAssignment,
  CloudAutoListingPlan,
  CloudAutoListingRun,
  CloudAsset,
  CloudListingConfigSnapshot,
  CloudListingBatch,
  CloudListingReconciliationSummary,
  ListingImageRepairItem,
  CloudMockupAsset,
  CloudMockupTemplate,
  CloudProductImageRule,
  CloudTitlePromptTemplate,
  CloudUser,
  JobLog,
  JobSummary,
  OrderPostingRow,
  ReserveAutoListingBatchInput,
  ReserveAutoListingBatchResult,
  Shop,
  ShopDailyListingStat,
} from "@shared/types";
import { callLocalAssistantCommand } from "./localAssistant";

const TOKEN_KEY = "ozon_sjsq_cloud_token";
export const CLOUD_AUTH_CHANGED_EVENT = "ozon_sjsq_cloud_auth_changed";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const isTauriRuntime = "__TAURI_INTERNALS__" in window;

export class CloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export interface CloudClient {
  health: () => Promise<{ ok: boolean; service: string; time: string }>;
  me: () => Promise<{ ok: boolean; user: CloudUser; features: string[] }>;
  login: (input: LoginInput) => Promise<AuthResult>;
  register: (input: RegisterInput) => Promise<AuthResult>;
  redeemLicense: (licenseKey: string) => Promise<{ ok: boolean; membership: { plan: string; planLabel: string; expiresAt: string } }>;
  getAiSettings: () => Promise<{ ok: boolean; settings: AiSettingsPublic }>;
  listShops: () => Promise<{ ok: boolean; shops: CloudShop[] }>;
  upsertShop: (shop: CloudShopDraft) => Promise<{ ok: boolean; shop: CloudShop }>;
  syncShop: (shop: Shop) => Promise<{ ok: boolean; shop: unknown }>;
  listAssets: (query: GalleryQuery) => Promise<GalleryListResult>;
  listFeaturedAssets: (query: FeaturedGalleryQuery) => Promise<GalleryListResult>;
  uploadAsset: (input: UploadAssetInput) => Promise<{ ok: boolean; asset: CloudAsset }>;
  uploadAssets: (files: File[], onProgress?: (task: GalleryUploadTask) => void, productImageRuleId?: string) => Promise<BatchUploadAssetsResult>;
  listProductImageRules: () => Promise<{ ok: boolean; rules: CloudProductImageRule[] }>;
  downloadAssetOriginal: (assetId: string) => Promise<Blob>;
  listMockupTemplates: () => Promise<{ ok: boolean; templates: CloudMockupTemplate[] }>;
  getMockupTemplatePackage: (templateId: string) => Promise<{ ok: boolean; template: CloudMockupTemplatePackage }>;
  uploadLocalMockupResult: (input: UploadLocalMockupResultInput) => Promise<UploadLocalMockupResult>;
  renderMockup: (templateId: string, assetId: string) => Promise<RenderMockupResult>;
  renderFangjinMockup: (assetId: string) => Promise<RenderMockupResult>;
  markAssetUsed: (assetId: string, externalShopId: string) => Promise<{ ok: boolean; used: { sku: string; shopId: string; externalShopId: string } }>;
  deleteAsset: (assetId: string) => Promise<{ ok: boolean; asset: { id: string; sku: string } }>;
  listTitlePromptTemplates: () => Promise<{ ok: boolean; templates: CloudTitlePromptTemplate[] }>;
  saveTitlePromptTemplate: (input: SaveTitlePromptTemplateInput) => Promise<{ ok: boolean; template: CloudTitlePromptTemplate }>;
  listProductTemplates: (externalShopId?: string) => Promise<{ ok: boolean; templates: CloudProductTemplate[] }>;
  saveProductTemplate: (input: SaveProductTemplateInput) => Promise<{ ok: boolean; template: CloudProductTemplate }>;
  getListingPreferences: () => Promise<{ ok: boolean; preferences: CloudListingPreferences; updatedAt?: string | null }>;
  saveListingPreferences: (input: CloudListingPreferences) => Promise<{ ok: boolean; preferences: CloudListingPreferences; updatedAt: string }>;
  listAutoListingPlans: () => Promise<{ ok: boolean; plans: CloudAutoListingPlan[] }>;
  saveAutoListingPlan: (input: SaveAutoListingPlanInput) => Promise<{ ok: boolean; plan: CloudAutoListingPlan }>;
  deleteAutoListingPlan: (planId: string) => Promise<{ ok: boolean; deletedPlanId: string }>;
  reserveAutoListingBatch: (input: ReserveAutoListingBatchInput) => Promise<{ ok: boolean } & ReserveAutoListingBatchResult>;
  updateAutoListingAssignments: (updates: AutoListingAssignmentUpdateInput[]) => Promise<{ ok: boolean; assignments: CloudAutoListingAssignment[] }>;
  releaseAutoListingAssignments: (assignmentIds: string[]) => Promise<{ ok: boolean; assignments: CloudAutoListingAssignment[] }>;
  listAutoListingRuns: (query?: AutoListingRunsQuery) => Promise<{ ok: boolean; runs: CloudAutoListingRunWithAssignments[] }>;
  generateListingTitle: (input: GenerateListingTitleInput) => Promise<GenerateListingTitleResult>;
  checkListingOccupancy: (input: ListingOccupancyCheckInput) => Promise<ListingOccupancyCheckResult>;
  createListingBatch: (input: CreateListingBatchInput) => Promise<{ ok: boolean; batch: CloudListingBatch }>;
  listListingBatches: (query?: { status?: "prepared" | "uploaded" | "failed"; limit?: number }) => Promise<{ ok: boolean; batches: CloudListingBatch[] }>;
  getListingBatch: (batchId: string) => Promise<{ ok: boolean; batch: CloudListingBatch }>;
  markListingBatchUploaded: (batchId: string) => Promise<{ ok: boolean; batch: CloudListingBatch }>;
  deleteListingUploads: (input: { batchIds: string[]; sourceAssetIds: string[] }) => Promise<{ ok: boolean; deletedBatches: number; deletedMockupAssets: number; releasedSourceAssets: number }>;
  listDailyListingStats: (query?: DailyListingStatsQuery) => Promise<{ ok: boolean; stats: ShopDailyListingStat[] }>;
  listListingReconciliation: (query?: DailyListingStatsQuery) => Promise<{ ok: boolean; summary: CloudListingReconciliationSummary }>;
  listListingImageRepairs: (query?: ListingImageRepairQuery) => Promise<ListingImageRepairListResult>;
  updateListingRepairImages: (input: UpdateListingRepairImagesInput) => Promise<UpdateListingRepairImagesResult>;
  syncSalesSignals: (signals: SalesSignalInput[]) => Promise<{ ok: boolean; synced: number; featuredUpdated: number }>;
  syncOrders: (orders: OrderPostingRow[]) => Promise<{ ok: boolean; synced: number }>;
  syncTaskHistory: (input: SyncTaskHistoryInput) => Promise<{ ok: boolean; jobsSynced: number; logsSynced: number }>;
  getProductCatalogStatus: () => Promise<{ ok: boolean; status: ProductCatalogStatus }>;
  listProductCatalogCategories: () => Promise<{ ok: boolean; categories: ProductCatalogCategory[] }>;
  listProductCatalogProducts: (query?: ProductCatalogQuery) => Promise<ProductCatalogListResult>;
  getProductCatalogProduct: (id: string) => Promise<{ ok: boolean; product: ProductCatalogDetail }>;
  // RBAC 管理接口（仅 admin 角色可调用）
  adminListFeatures: () => Promise<AdminFeatureListResult>;
  adminUpdateFeature: (featureKey: string, body: AdminFeatureUpdateInput) => Promise<{ ok: boolean; feature: AdminFeatureFlag }>;
  adminListUsers: (query?: AdminUsersQuery) => Promise<AdminUsersListResult>;
  adminUpdateUserRole: (userId: string, role: "member" | "beta" | "admin") => Promise<{ ok: boolean; user: { id: string; phone: string; role: string } }>;
  adminGetUserFeatures: (userId: string) => Promise<AdminUserFeaturesResult>;
  adminGrantUserFeature: (userId: string, featureKey: string, expiresAt?: string) => Promise<{ ok: boolean; access: AdminUserFeatureAccess }>;
  adminRevokeUserFeature: (userId: string, featureKey: string) => Promise<{ ok: boolean; revoked: boolean }>;
  adminListAuditLogs: (query?: AdminAuditLogsQuery) => Promise<AdminAuditLogsResult>;
}

export interface ProductCatalogStatus {
  syncing: boolean;
  startedAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  productCount: number;
  assetCount: number;
}

export interface ProductCatalogCategory {
  categoryId?: number;
  id?: number;
  categoryName?: string;
  name?: string;
  children?: ProductCatalogCategory[];
}

export interface ProductCatalogItem {
  id: string;
  sourceProductId: number;
  title: string;
  categoryId?: number | null;
  categoryName?: string | null;
  priceMin?: number | null;
  priceMax?: number | null;
  weightMin?: number | null;
  weightMax?: number | null;
  deliveryTimeText?: string | null;
  coverUrl?: string | null;
  sourceActive: boolean;
  updatedAt: string;
}

export interface ProductCatalogDetail {
  id: string;
  sourceProductId: number;
  title: string;
  sourceActive: boolean;
  detail: Record<string, unknown>;
  assetMap: Record<string, string>;
  updatedAt: string;
}

export interface ProductCatalogQuery {
  keyword?: string;
  categoryId?: number;
  sourceActive?: "true" | "false" | "all";
  pageNo?: number;
  pageSize?: number;
}

export interface ProductCatalogListResult {
  ok: boolean;
  products: ProductCatalogItem[];
  total: number;
  pageNo: number;
  pageSize: number;
}

// ============================================================
// RBAC 管理接口类型
// ============================================================

export interface AdminFeatureFlag {
  key: string;
  label: string;
  module: string;
  description: string | null;
  default_roles: string[];
  is_active: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export interface AdminFeatureListResult {
  ok: boolean;
  features: AdminFeatureFlag[];
}

export interface AdminFeatureUpdateInput {
  defaultRoles?: ("member" | "beta" | "admin")[];
  isActive?: boolean;
}

export interface AdminUserListItem {
  id: string;
  phone: string;
  display_name: string | null;
  role: string;
  membership_plan: string | null;
  membership_expires_at: string | null;
  gallery_storage_limit_bytes: number | null;
  last_login_at: string | null;
  created_at: string;
  device_name: string | null;
  last_seen_at: string | null;
  shop_count: number;
  gallery_usage_count: number;
  gallery_storage_used_bytes: string;
}

export interface AdminUsersQuery {
  keyword?: string;
  membership?: "all" | "active" | "expired" | "none";
  deletionState?: "active" | "deleted" | "all";
  limit?: number;
  offset?: number;
}

export interface AdminUsersListResult {
  ok: boolean;
  items: AdminUserListItem[];
  users: AdminUserListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUserFeatureAccess {
  feature_key: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  label: string;
  module: string;
}

export interface AdminUserFeaturesResult {
  ok: boolean;
  user: { id: string; phone: string; role: string };
  access: AdminUserFeatureAccess[];
}

export interface AdminAuditLogItem {
  id: string;
  action: string;
  feature_key: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
  admin_phone: string | null;
  target_phone: string | null;
}

export interface AdminAuditLogsQuery {
  limit?: number;
  offset?: number;
  action?: "all" | "role_change" | "feature_grant" | "feature_revoke";
}

export interface AdminAuditLogsResult {
  ok: boolean;
  items: AdminAuditLogItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface LoginInput {
  phone: string;
  password: string;
  deviceFingerprint: string;
  deviceName?: string;
}

export interface RegisterInput extends LoginInput {
  licenseKey?: string;
}

export interface AuthResult {
  ok: boolean;
  token: string;
  user: CloudUser;
}

export interface CloudShop {
  id: string;
  external_shop_id?: string;
  externalShopId?: string;
  name: string;
  ozon_client_id?: string | null;
  ozonClientId?: string | null;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
}

export interface CloudShopDraft {
  externalShopId: string;
  name: string;
  ozonClientId?: string;
}

export interface GalleryQuery {
  ratioFamily?: string;
  productImageRuleId?: string;
  keyword?: string;
  externalShopId?: string;
  excludeAssetIds?: string[];
  hideUsed?: boolean;
  listingStatus?: "pending" | "processing" | "uploaded";
  mockupTemplateId?: string;
  mockupStatus?: "all" | "not_rendered" | "rendered";
  limit?: number;
  offset?: number;
  includeTotal?: boolean;
}

export interface FeaturedGalleryQuery {
  ratioFamily?: string;
  productImageRuleId?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
  includeTotal?: boolean;
}

export interface ListingImageRepairQuery {
  externalShopId?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface DailyListingStatsQuery {
  dateFrom?: string;
  dateTo?: string;
  externalShopId?: string;
}

export interface GalleryListResult {
  ok: boolean;
  assets: CloudAsset[];
  total?: number;
  limit: number;
  offset: number;
}

export interface ListingImageRepairListResult {
  ok: boolean;
  items: ListingImageRepairItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface UpdateListingRepairImagesInput {
  items: Array<{
    batchId?: string;
    externalShopId: string;
    sourceAssetId?: string;
    sourceSku: string;
    imageAssetIds: string[];
  }>;
}

export interface UpdateListingRepairImagesResult {
  ok: boolean;
  updated: number;
  items: ListingImageRepairItem[];
  errors: Array<{ sourceSku: string; externalShopId: string; message: string }>;
}

export interface SalesSignalInput {
  externalShopId: string;
  sku: string;
  orderCount: number;
  quantity?: number;
  lastOrderedAt?: string;
  source?: string;
}

export interface SyncTaskHistoryInput {
  jobs: JobSummary[];
  logs: JobLog[];
}

export interface CloudProductTemplate {
  id: string;
  externalShopId: string;
  shopName: string;
  shared?: boolean;
  name: string;
  externalTemplateId?: string | null;
  categoryLabel?: string | null;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SaveTitlePromptTemplateInput {
  id?: string;
  name: string;
  prompt: string;
}

export interface SaveProductTemplateInput {
  externalShopId?: string;
  shared?: boolean;
  id?: string;
  name: string;
  externalTemplateId?: string;
  categoryLabel?: string;
  payload?: unknown;
}

export type ListingShopTargetInput = SaveProductTemplateInput & {
  externalShopId: string;
  configSnapshot?: CloudListingConfigSnapshot;
};

export interface CloudListingPreferenceShopConfig {
  externalShopId: string;
  productTemplateId?: string;
  productTemplateName?: string;
  newTemplateName?: string;
  categoryLabel?: string;
  productTemplateShared?: boolean;
  localTemplateId?: string;
  autoGenerateBarcode?: boolean;
  autoUpdateStock?: boolean;
  autoAddToAction?: boolean;
  autoWarehouseId?: number | "";
  autoStock?: number;
  autoActionId?: number | "";
  autoActionPrice?: string;
  autoActionStock?: number;
  actionDelayMinutes?: number;
  actionRetryCount?: number;
  actionRetryIntervalMinutes?: number;
  dailyListingLimit?: number;
}

export interface CloudListingPreferences {
  ratioFamily?: GalleryQuery["ratioFamily"] | "";
  productImageRuleId?: string;
  selectedShopId?: string;
  selectedMockupTemplate?: string;
  selectedTitlePromptId?: string;
  titlePromptName?: string;
  titlePrompt?: string;
  shopListingConfigs?: CloudListingPreferenceShopConfig[];
}

export type SaveAutoListingPlanInput = Omit<CloudAutoListingPlan, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export interface AutoListingAssignmentUpdateInput {
  assignmentId: string;
  status: AutoListingAssignmentStatus;
  batchId?: string | null;
  retryCount?: number;
  lastError?: string | null;
}

export interface AutoListingRunsQuery {
  planId?: string;
  status?: CloudAutoListingRun["status"];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export type CloudAutoListingRunWithAssignments = CloudAutoListingRun & {
  assignments: CloudAutoListingAssignment[];
};

export type MockupTemplateJson = {
  id?: string;
  name?: string;
  outputWidth: number;
  outputHeight: number;
  outputFormat?: "jpeg" | "png" | "webp";
  outputQuality?: number;
  sourceSize?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFit?: "cover" | "fill";
  linearLightStrength?: number;
  scenes: Array<{
    id: string;
    index: number;
    width: number;
    height: number;
    linearLightStrength?: number;
    layers: Array<{
      order: number;
      left: number;
      top: number;
      width: number;
      height: number;
      opacity?: number;
      blendMode?: string;
      blendStrength?: number;
      kind: "image" | "replace";
      file?: string;
      mask?: string;
      maskLeft?: number;
      maskTop?: number;
      maskWidth?: number;
      maskHeight?: number;
      clipMask?: string;
      clipMaskLeft?: number;
      clipMaskTop?: number;
      clipMaskWidth?: number;
      clipMaskHeight?: number;
      transform?: number[];
      psTransform?: number[];
      nonAffineTransform?: number[];
      perspectiveMesh?: {
        vertices: Array<{ x: number; y: number }>;
        warpedVertices: Array<{ x: number; y: number }>;
        quads: number[][];
      };
      uvMapX?: string;
      uvMapY?: string;
      sampleMode?: "edge" | "center";
      interpolation?: string;
      sourceCrop?: { left: number; top: number; width: number; height: number };
      edgeFeather?: number;
    }>;
  }>;
};

export interface CloudMockupTemplatePackage extends CloudMockupTemplate {
  templateDir: string;
  templateJson: MockupTemplateJson;
  assetUrls: Record<string, string>;
  version: string;
}

export interface GenerateListingTitleInput {
  sourceAssetId: string;
  imageAssetId: string;
  prompt: string;
}

export interface GenerateListingTitleResult {
  ok: boolean;
  title: string;
  sourceAssetId: string;
  imageAssetId: string;
  asset?: Pick<CloudAsset, "id" | "sku" | "generatedTitle" | "generatedTitleImageAssetId" | "generatedTitlePrompt" | "generatedTitleUpdatedAt"> | null;
}

export interface UploadLocalMockupResultInput {
  templateId: string;
  sourceAssetId: string;
  sceneIndex: number;
  filename: string;
  blob: Blob;
  clientRenderer?: string;
}

export interface UploadLocalMockupResult extends Omit<RenderMockupResult, "assets"> {
  asset: CloudMockupAsset;
  renderer?: string;
}

export interface CreateListingBatchInput {
  ratioFamily?: CloudAsset["ratioFamily"];
  productImageRuleId: string;
  mockupTemplateId: string;
  mockupTemplateName: string;
  titlePromptTemplateId?: string;
  titlePromptTemplateName?: string;
  titlePrompt?: string;
  shopTargets: ListingShopTargetInput[];
  assets: Array<{
    sourceAssetId: string;
    externalShopId: string;
    imageAssetIds: string[];
    title?: string;
  }>;
}

export interface ListingOccupancyCheckInput {
  items: Array<{ sourceAssetId: string; externalShopId: string }>;
}

export interface ListingOccupancyCheckResult {
  ok: boolean;
  occupied: Array<{ sourceAssetId: string; externalShopId: string }>;
}

export interface UploadAssetInput {
  file: File;
  sku?: string;
  productImageRuleId: string;
}

export interface BatchUploadAssetsResult {
  ok: boolean;
  uploaded: number;
  failed: number;
  assets: CloudAsset[];
  errors: Array<{ filename: string; message: string }>;
}

interface DirectUploadPreparedItem {
  clientItemId: string;
  file: File;
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  sku: string;
  thumbnail: Blob;
}

interface DirectUploadPrepareResult {
  ok: boolean;
  items: Array<{
    clientItemId: string;
    originalUploadUrl: string;
    thumbnailUploadUrl: string;
  }>;
  skipped: Array<{ clientItemId: string; filename: string; sha256: string }>;
  errors: Array<{ clientItemId: string; filename: string; message: string }>;
}

export interface GalleryUploadTask {
  id: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  totalFiles: number;
  totalBytes: number;
  uploaded: number;
  failed: number;
  processed: number;
  message?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
  assets: CloudAsset[];
  errors: Array<{ filename: string; message: string }>;
}

export interface RenderMockupResult {
  ok: boolean;
  sourceAsset: {
    id: string;
    sku: string;
    sourceFilename: string;
  };
  template: {
    id: string;
    name: string;
    sceneCount: number;
    outputWidth: number;
    outputHeight: number;
  };
  generated: number;
  assets: CloudMockupAsset[];
}

export function getCloudToken() {
  return window.localStorage.getItem(TOKEN_KEY) || "";
}

export function setCloudToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
  responseCache.clear();
  window.dispatchEvent(new Event(CLOUD_AUTH_CHANGED_EVENT));
}

export function clearCloudToken() {
  window.localStorage.removeItem(TOKEN_KEY);
  responseCache.clear();
  window.dispatchEvent(new Event(CLOUD_AUTH_CHANGED_EVENT));
}

export function isCloudApiError(error: unknown): error is CloudApiError {
  return error instanceof CloudApiError;
}

export function isAuthFailure(error: unknown) {
  return isCloudApiError(error) && error.status === 401;
}

export function isMembershipRequired(error: unknown) {
  return isCloudApiError(error) && error.status === 402;
}

export function createCloudClient(baseUrl: string): CloudClient {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  return {
    health: () => request(normalizedBaseUrl, "/health"),
    me: () => request(normalizedBaseUrl, "/me", { auth: true }),
    login: (input) => request(normalizedBaseUrl, "/auth/login", { method: "POST", body: input }),
    register: (input) => request(normalizedBaseUrl, "/auth/register", { method: "POST", body: input }),
    redeemLicense: (licenseKey) => request(normalizedBaseUrl, "/license/redeem", { method: "POST", auth: true, body: { licenseKey } }),
    getAiSettings: () => request(normalizedBaseUrl, "/ai/settings", { auth: true }),
    listShops: () => request(normalizedBaseUrl, "/shops", { auth: true }),
    upsertShop: (shop) => request(normalizedBaseUrl, "/shops/upsert", { method: "POST", auth: true, body: shop }),
    syncShop: (shop) => request(normalizedBaseUrl, "/shops/upsert", {
      method: "POST",
      auth: true,
      body: {
        externalShopId: shop.id,
        name: shop.name,
        ozonClientId: shop.clientId,
      },
    }),
    getProductCatalogStatus: () => request(normalizedBaseUrl, "/product-catalog/status", { auth: true }),
    listProductCatalogCategories: () => request(normalizedBaseUrl, "/product-catalog/categories", { auth: true }),
    listProductCatalogProducts: (query = {}) => {
      const params = new URLSearchParams();
      if (query.keyword) params.set("keyword", query.keyword);
      if (query.categoryId) params.set("categoryId", String(query.categoryId));
      if (query.sourceActive) params.set("sourceActive", query.sourceActive);
      if (query.pageNo) params.set("pageNo", String(query.pageNo));
      if (query.pageSize) params.set("pageSize", String(query.pageSize));
      const suffix = params.size ? `?${params.toString()}` : "";
      return request(normalizedBaseUrl, `/product-catalog/products${suffix}`, { auth: true });
    },
    getProductCatalogProduct: (id) => request(normalizedBaseUrl, `/product-catalog/products/${encodeURIComponent(id)}`, { auth: true }),
    // RBAC 管理接口
    adminListFeatures: () => request(normalizedBaseUrl, "/admin/features", { auth: true }),
    adminUpdateFeature: (featureKey, body) => request(normalizedBaseUrl, `/admin/features/${encodeURIComponent(featureKey)}`, {
      method: "PUT",
      auth: true,
      body,
    }),
    adminListUsers: (query = {}) => {
      const params = new URLSearchParams();
      if (query.keyword) params.set("keyword", query.keyword);
      if (query.membership) params.set("membership", query.membership);
      if (query.deletionState) params.set("deletionState", query.deletionState);
      if (query.limit) params.set("limit", String(query.limit));
      if (query.offset) params.set("offset", String(query.offset));
      const suffix = params.toString();
      return request(normalizedBaseUrl, `/admin/users${suffix ? `?${suffix}` : ""}`, { auth: true, timeoutMs: 30_000 });
    },
    adminUpdateUserRole: (userId, role) => request(normalizedBaseUrl, `/admin/users/${encodeURIComponent(userId)}/role`, {
      method: "PUT",
      auth: true,
      body: { role },
    }),
    adminGetUserFeatures: (userId) => request(normalizedBaseUrl, `/admin/users/${encodeURIComponent(userId)}/features`, { auth: true }),
    adminGrantUserFeature: (userId, featureKey, expiresAt) => request(normalizedBaseUrl, `/admin/users/${encodeURIComponent(userId)}/features`, {
      method: "POST",
      auth: true,
      body: { featureKey, expiresAt },
    }),
    adminRevokeUserFeature: (userId, featureKey) => request(normalizedBaseUrl, `/admin/users/${encodeURIComponent(userId)}/features/${encodeURIComponent(featureKey)}`, {
      method: "DELETE",
      auth: true,
    }),
    adminListAuditLogs: (query = {}) => {
      const params = new URLSearchParams();
      if (query.limit) params.set("limit", String(query.limit));
      if (query.offset) params.set("offset", String(query.offset));
      if (query.action) params.set("action", query.action);
      const suffix = params.toString();
      return request(normalizedBaseUrl, `/admin/audit-logs${suffix ? `?${suffix}` : ""}`, { auth: true, timeoutMs: 30_000 });
    },
    listAssets: async (query) => validateGalleryListResult(query.excludeAssetIds?.length
      ? await request(normalizedBaseUrl, "/gallery/assets/query", { method: "POST", auth: true, body: query })
      : await request(normalizedBaseUrl, `/gallery/assets${galleryQueryString(query)}`, { auth: true })),
    listFeaturedAssets: async (query) => validateGalleryListResult(
      await request(normalizedBaseUrl, `/gallery/featured-assets${galleryQueryString(query)}`, { auth: true }),
    ),
    uploadAsset: (input) => uploadAsset(normalizedBaseUrl, input),
    uploadAssets: (files, onProgress, productImageRuleId) => uploadAssets(normalizedBaseUrl, files, onProgress, productImageRuleId),
    listProductImageRules: () => cachedRequest(normalizedBaseUrl, "/gallery/product-image-rules", { auth: true }, 5 * 60_000),
    downloadAssetOriginal: (assetId) => downloadAssetOriginal(normalizedBaseUrl, assetId),
    listMockupTemplates: () => cachedRequest(normalizedBaseUrl, "/mockups/templates", { auth: true }, 5 * 60_000),
    getMockupTemplatePackage: (templateId) => request(
      normalizedBaseUrl,
      `/mockups/${encodeURIComponent(templateId)}/package`,
      { auth: true, timeoutMs: 30_000 },
    ),
    uploadLocalMockupResult: (input) => uploadLocalMockupResult(normalizedBaseUrl, input),
    renderMockup: (templateId, assetId) => request(normalizedBaseUrl, `/mockups/${encodeURIComponent(templateId)}/render`, {
      method: "POST",
      auth: true,
      body: { assetId },
      timeoutMs: 60_000,
    }),
    renderFangjinMockup: (assetId) => request(normalizedBaseUrl, "/mockups/fangjin/render", {
      method: "POST",
      auth: true,
      body: { assetId },
      timeoutMs: 60_000,
    }),
    markAssetUsed: (assetId, externalShopId) => request(normalizedBaseUrl, `/gallery/assets/${assetId}/use-by-external-shop`, {
      method: "POST",
      auth: true,
      body: { externalShopId },
    }),
    deleteAsset: (assetId) => request(normalizedBaseUrl, `/gallery/assets/${encodeURIComponent(assetId)}`, {
      method: "DELETE",
      auth: true,
    }),
    listTitlePromptTemplates: () => cachedRequest(normalizedBaseUrl, "/gallery/title-prompts", { auth: true }, 60_000),
    saveTitlePromptTemplate: async (input) => {
      const result = await request<{ ok: boolean; template: CloudTitlePromptTemplate }>(normalizedBaseUrl, "/gallery/title-prompts", {
        method: "POST",
        auth: true,
        body: input,
      });
      clearResponseCache(normalizedBaseUrl, "/gallery/title-prompts");
      return result;
    },
    listProductTemplates: (externalShopId) => cachedRequest(
      normalizedBaseUrl,
      `/gallery/product-templates${externalShopId ? `?externalShopId=${encodeURIComponent(externalShopId)}` : ""}`,
      { auth: true },
      60_000,
    ),
    saveProductTemplate: async (input) => {
      const result = await request<{ ok: boolean; template: CloudProductTemplate }>(normalizedBaseUrl, "/gallery/product-templates", {
        method: "POST",
        auth: true,
        body: input,
      });
      clearResponseCache(normalizedBaseUrl, "/gallery/product-templates");
      return result;
    },
    getListingPreferences: () => request(normalizedBaseUrl, "/gallery/listing-preferences", { auth: true }),
    saveListingPreferences: (input) => request(normalizedBaseUrl, "/gallery/listing-preferences", {
      method: "PUT",
      auth: true,
      body: input,
      timeoutMs: 30_000,
    }),
    listAutoListingPlans: () => request(normalizedBaseUrl, "/gallery/auto-listing/plans", {
      auth: true,
      timeoutMs: 30_000,
    }),
    saveAutoListingPlan: async (input) => {
      const { id, ...body } = input;
      const result = await request<{ ok: boolean; plan: CloudAutoListingPlan }>(
        normalizedBaseUrl,
        id ? `/gallery/auto-listing/plans/${encodeURIComponent(id)}` : "/gallery/auto-listing/plans",
        { method: id ? "PUT" : "POST", auth: true, body, timeoutMs: 30_000 },
      );
      clearResponseCache(normalizedBaseUrl, "/gallery/auto-listing");
      return result;
    },
    deleteAutoListingPlan: async (planId) => {
      const result = await request<{ ok: boolean; deletedPlanId: string }>(
        normalizedBaseUrl,
        `/gallery/auto-listing/plans/${encodeURIComponent(planId)}`,
        { method: "DELETE", auth: true, timeoutMs: 30_000 },
      );
      clearResponseCache(normalizedBaseUrl, "/gallery/auto-listing");
      return result;
    },
    reserveAutoListingBatch: (input) => request(normalizedBaseUrl, "/gallery/auto-listing/reservations", {
      method: "POST",
      auth: true,
      body: input,
      timeoutMs: 60_000,
    }),
    updateAutoListingAssignments: (updates) => request(normalizedBaseUrl, "/gallery/auto-listing/assignments/progress", {
      method: "POST",
      auth: true,
      body: { updates },
      timeoutMs: 60_000,
    }),
    releaseAutoListingAssignments: (assignmentIds) => request(normalizedBaseUrl, "/gallery/auto-listing/assignments/release", {
      method: "POST",
      auth: true,
      body: { assignmentIds },
      timeoutMs: 60_000,
    }),
    listAutoListingRuns: (query = {}) => {
      const params = new URLSearchParams();
      if (query.planId) params.set("planId", query.planId);
      if (query.status) params.set("status", query.status);
      if (query.dateFrom) params.set("dateFrom", query.dateFrom);
      if (query.dateTo) params.set("dateTo", query.dateTo);
      if (query.limit) params.set("limit", String(query.limit));
      const suffix = params.toString();
      return request(
        normalizedBaseUrl,
        `/gallery/auto-listing/runs${suffix ? `?${suffix}` : ""}`,
        { auth: true, timeoutMs: 30_000 },
      );
    },
    generateListingTitle: (input) => request(normalizedBaseUrl, "/gallery/titles/generate", {
      method: "POST",
      auth: true,
      body: input,
      timeoutMs: 360_000,
    }),
    checkListingOccupancy: (input) => request(normalizedBaseUrl, "/gallery/listing-occupancy/check", {
      method: "POST",
      auth: true,
      body: input,
      timeoutMs: 60_000,
    }),
    createListingBatch: (input) => request(normalizedBaseUrl, "/gallery/listing-batches", {
      method: "POST",
      auth: true,
      body: input,
      timeoutMs: 300_000,
    }),
    listListingBatches: (query = {}) => {
      const params = new URLSearchParams();
      if (query.status) params.set("status", query.status);
      if (query.limit) params.set("limit", String(query.limit));
      const suffix = params.toString();
      return request(normalizedBaseUrl, `/gallery/listing-batches${suffix ? `?${suffix}` : ""}`, { auth: true, timeoutMs: 30_000 });
    },
    getListingBatch: (batchId) => request(normalizedBaseUrl, `/gallery/listing-batches/${encodeURIComponent(batchId)}`, {
      auth: true,
      timeoutMs: 30_000,
    }),
    markListingBatchUploaded: (batchId) => request(normalizedBaseUrl, `/gallery/listing-batches/${encodeURIComponent(batchId)}/mark-uploaded`, {
      method: "POST",
      auth: true,
      timeoutMs: 30_000,
    }),
    deleteListingUploads: (input) => request(normalizedBaseUrl, "/gallery/listing-uploads", {
      method: "DELETE",
      auth: true,
      body: input,
      timeoutMs: 120_000,
    }),
    listDailyListingStats: (query = {}) => request(
      normalizedBaseUrl,
      `/gallery/listing-stats/daily${dailyListingStatsQueryString(query)}`,
      { auth: true, timeoutMs: 30_000 },
    ),
    listListingReconciliation: (query = {}) => request(
      normalizedBaseUrl,
      `/gallery/listing-reconciliation${dailyListingStatsQueryString(query)}`,
      { auth: true, timeoutMs: 30_000 },
    ),
    listListingImageRepairs: (query = {}) => request(
      normalizedBaseUrl,
      `/gallery/listing-image-repairs${listingImageRepairQueryString(query)}`,
      { auth: true, timeoutMs: 120_000 },
    ),
    updateListingRepairImages: (input) => request(normalizedBaseUrl, "/gallery/listing-image-repairs/images", {
      method: "POST",
      auth: true,
      body: input,
      timeoutMs: 180_000,
    }),
    syncSalesSignals: (signals) => request(normalizedBaseUrl, "/gallery/sales-signals/sync", {
      method: "POST",
      auth: true,
      body: { signals },
      timeoutMs: 30_000,
    }),
    syncOrders: (orders) => request(normalizedBaseUrl, "/orders/sync", {
      method: "POST",
      auth: true,
      body: { orders },
      timeoutMs: 60_000,
    }),
    syncTaskHistory: (input) => request(normalizedBaseUrl, "/tasks/history/sync", {
      method: "POST",
      auth: true,
      body: input,
      timeoutMs: 30_000,
    }),
  };
}

function validateGalleryListResult(value: unknown): GalleryListResult {
  if (!value || typeof value !== "object") {
    throw new CloudApiError("图库返回数据格式不正确，请更新客户端助手后重试", 0, "INVALID_GALLERY_RESPONSE");
  }
  const result = value as Partial<GalleryListResult>;
  if (!Array.isArray(result.assets)) {
    throw new CloudApiError("图库返回缺少图片列表，请更新客户端助手后重试", 0, "INVALID_GALLERY_ASSETS");
  }
  return {
    ok: result.ok !== false,
    assets: result.assets,
    total: typeof result.total === "number" ? result.total : undefined,
    limit: typeof result.limit === "number" ? result.limit : result.assets.length,
    offset: typeof result.offset === "number" ? result.offset : 0,
  };
}

async function request<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  if (!isTauriRuntime) {
    return requestThroughLocalAssistant<T>(baseUrl, path, options);
  }
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  if (options.auth) {
    const token = getCloudToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw createApiError(response, data, "云服务请求失败");
    }
    return data as T;
  } catch (error) {
    if (error instanceof CloudApiError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new CloudApiError("云服务响应超时，请稍后重试", 0, "REQUEST_TIMEOUT");
    }
    throw new CloudApiError("云服务连接失败，请检查网络后重试", 0, "NETWORK_ERROR");
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function requestThroughLocalAssistant<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number },
): Promise<T> {
  const token = options.auth ? getCloudToken() : "";
  const result = await callLocalAssistantCommand<{
    ok: boolean;
    status: number;
    data: unknown;
    fromCache: boolean;
  }>("cloud_request", {
    request: {
      baseUrl,
      path,
      method: options.method ?? "GET",
      body: options.body,
      authToken: token || undefined,
      accountId: cloudAccountId(token),
    },
  });
  if (!result.ok) {
    const body = typeof result.data === "object" && result.data !== null ? result.data as Record<string, unknown> : {};
    const message = typeof body.message === "string" ? body.message : `云服务请求失败：HTTP ${result.status}`;
    throw new CloudApiError(message, result.status, typeof body.code === "string" ? body.code : undefined);
  }
  return result.data as T;
}

export function cloudAccountId(token = getCloudToken()) {
  if (!token) return "";
  try {
    const payload = token.split(".")[1];
    if (!payload) return "";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const data = JSON.parse(window.atob(normalized)) as Record<string, unknown>;
    const value = data.sub ?? data.userId ?? data.id;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

async function cachedRequest<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {},
  ttlMs: number,
): Promise<T> {
  const key = responseCacheKey(baseUrl, path, options);
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as T;
  }
  const value = await request<T>(baseUrl, path, options);
  responseCache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

function clearResponseCache(baseUrl: string, pathPrefix: string) {
  const prefix = `${baseUrl}|${getCloudToken()}|${pathPrefix}`;
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) {
      responseCache.delete(key);
    }
  }
}

function responseCacheKey(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean },
) {
  return [
    baseUrl,
    options.auth ? getCloudToken() : "",
    path,
    options.method ?? "GET",
    options.body ? JSON.stringify(options.body) : "",
  ].join("|");
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim() || "https://api.dyxtoolai.cn";
  return trimmed.replace(/\/+$/, "");
}

async function uploadAsset(baseUrl: string, input: UploadAssetInput) {
  try {
    const result = await uploadAssetsDirect(baseUrl, [input.file], input.productImageRuleId);
    const asset = result.assets[0];
    if (asset) {
      return { ok: true, asset };
    }
  } catch (error) {
    if (!shouldFallbackFromDirectUpload(error)) {
      throw error;
    }
  }

  const token = getCloudToken();
  const form = new FormData();
  if (input.sku?.trim()) {
    form.append("sku", input.sku.trim());
  }
  form.append("productImageRuleId", input.productImageRuleId);
  form.append("file", input.file);
  const response = await fetch(`${baseUrl}/gallery/assets/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "云图库上传失败");
  }
  return data as { ok: boolean; asset: CloudAsset };
}

async function uploadAssets(
  baseUrl: string,
  files: File[],
  onProgress?: (task: GalleryUploadTask) => void,
  productImageRuleId?: string,
) {
  try {
    onProgress?.(directUploadProgress("running", files.length, 0, 0, "正在准备对象存储直传"));
    const result = await uploadAssetsDirect(baseUrl, files, productImageRuleId, (uploaded, failed, message) => {
      onProgress?.(directUploadProgress("running", files.length, uploaded, failed, message));
    });
    onProgress?.(directUploadProgress(result.failed > 0 ? "partial" : "succeeded", files.length, result.uploaded, result.failed, "直传完成"));
    return result;
  } catch (error) {
    if (!shouldFallbackFromDirectUpload(error)) {
      throw error;
    }
    onProgress?.(directUploadProgress("running", files.length, 0, 0, "直传不可用，切换旧版兼容上传"));
  }

  let task: GalleryUploadTask;
  try {
    task = await createBatchUploadTask(baseUrl, files, productImageRuleId);
    onProgress?.(task);
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) {
      return uploadAssetsLegacy(baseUrl, files, productImageRuleId);
    }
    throw error;
  }

  const completedTask = await waitForBatchUploadTask(baseUrl, task.id, onProgress);
  return {
    ok: completedTask.failed === 0,
    uploaded: completedTask.uploaded,
    failed: completedTask.failed,
    assets: completedTask.assets,
    errors: completedTask.errors,
  } satisfies BatchUploadAssetsResult;
}

async function uploadAssetsDirect(
  baseUrl: string,
  files: File[],
  productImageRuleId?: string,
  onProgress?: (uploaded: number, failed: number, message: string) => void,
): Promise<BatchUploadAssetsResult> {
  if (!productImageRuleId) {
    throw new Error("请选择商品图片规则后再上传");
  }
  const prepared = await Promise.all(files.map((file, index) => prepareDirectUploadItem(file, index)));
  const body = {
    productImageRuleId,
    items: prepared.map((item) => directUploadRequestItem(item)),
  };
  const prepareResult = await request<DirectUploadPrepareResult>(baseUrl, "/gallery/assets/direct-upload/prepare", {
    method: "POST",
    auth: true,
    body,
    timeoutMs: 30_000,
  });
  if (!prepareResult.ok && prepareResult.items.length === 0 && prepareResult.skipped.length === 0) {
    return directUploadFailureResult(prepared, prepareResult.errors);
  }

  const preparedById = new Map(prepared.map((item) => [item.clientItemId, item]));
  const errors = [...prepareResult.errors.map((item) => ({ filename: item.filename, message: item.message }))];
  const failedClientIds = new Set(prepareResult.errors.map((item) => item.clientItemId));
  let uploadedObjects = 0;
  for (const item of prepareResult.items) {
    const source = preparedById.get(item.clientItemId);
    if (!source) {
      continue;
    }
    try {
      await putDirectUpload(item.originalUploadUrl, source.file, source.contentType);
      await putDirectUpload(item.thumbnailUploadUrl, source.thumbnail, "image/webp");
      uploadedObjects += 1;
      onProgress?.(uploadedObjects, errors.length, `正在直传图片 ${uploadedObjects}/${prepareResult.items.length}`);
    } catch (error) {
      failedClientIds.add(item.clientItemId);
      errors.push({ filename: source.filename, message: uploadErrorMessage(error) });
    }
  }

  const completedIds = new Set([
    ...prepareResult.skipped.map((item) => item.clientItemId),
    ...prepareResult.items
      .filter((item) => !failedClientIds.has(item.clientItemId))
      .map((item) => item.clientItemId),
  ]);
  const completeItems = prepared.filter((item) => completedIds.has(item.clientItemId));
  const completeResult = completeItems.length > 0
    ? await request<BatchUploadAssetsResult>(baseUrl, "/gallery/assets/direct-upload/complete", {
        method: "POST",
        auth: true,
        body: {
          productImageRuleId,
          items: completeItems.map((item) => directUploadRequestItem(item)),
        },
        timeoutMs: 60_000,
      })
    : { ok: false, uploaded: 0, failed: 0, assets: [], errors: [] };

  const allErrors = [
    ...errors,
    ...normalizeDirectCompleteErrors(completeResult.errors),
  ];
  const uploaded = completeResult.assets.length;
  const failed = Math.max(0, files.length - uploaded);
  return {
    ok: failed === 0,
    uploaded,
    failed,
    assets: completeResult.assets,
    errors: allErrors.length > 0 ? allErrors : files.slice(uploaded).map((file) => ({ filename: fileDisplayName(file), message: "直传未完成" })),
  };
}

async function prepareDirectUploadItem(file: File, index: number): Promise<DirectUploadPreparedItem> {
  const contentType = normalizeDirectUploadContentType(file.type);
  const [sha256, dimensions, thumbnail] = await Promise.all([
    sha256File(file),
    readImageDimensions(file),
    createDirectUploadThumbnail(file),
  ]);
  return {
    clientItemId: `${Date.now().toString(36)}-${index}`,
    file,
    filename: fileDisplayName(file),
    contentType,
    sizeBytes: file.size,
    sha256,
    width: dimensions.width,
    height: dimensions.height,
    sku: fileDisplayName(file).replace(/\.[^.]+$/, ""),
    thumbnail,
  };
}

function directUploadRequestItem(item: DirectUploadPreparedItem) {
  return {
    clientItemId: item.clientItemId,
    filename: item.filename,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    width: item.width,
    height: item.height,
    sku: item.sku,
  };
}

async function sha256File(file: File) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前浏览器不支持本地计算图片指纹");
  }
  const hash = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(hash)).map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function readImageDimensions(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadUploadImage(url);
    return { width: image.width, height: image.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function createDirectUploadThumbnail(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadUploadImage(url);
    const scale = Math.min(1, 360 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("当前浏览器不支持生成缩略图");
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasToUploadBlob(canvas, "image/webp", 0.74);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadUploadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败，请确认文件格式正确"));
    image.src = url;
  });
}

function canvasToUploadBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("当前浏览器不支持生成 WebP 缩略图"));
      }
    }, type, quality);
  });
}

async function putDirectUpload(url: string, body: Blob, contentType: string) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!response.ok) {
    throw new Error(`对象存储上传失败：HTTP ${response.status}`);
  }
}

function normalizeDirectUploadContentType(value: string): DirectUploadPreparedItem["contentType"] {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") {
    return value;
  }
  throw new Error("仅支持 PNG、JPG、WebP 图片直传");
}

function shouldFallbackFromDirectUpload(error: unknown) {
  if (error instanceof CloudApiError) {
    return [400, 404, 410, 413, 415, 501].includes(error.status)
      || error.code === "NETWORK_ERROR"
      || error.code === "REQUEST_TIMEOUT";
  }
  const message = uploadErrorMessage(error).toLowerCase();
  return message.includes("直传")
    || message.includes("对象存储")
    || message.includes("browser")
    || message.includes("浏览器")
    || message.includes("webp")
    || message.includes("canvas")
    || message.includes("fingerprint")
    || message.includes("指纹");
}

function directUploadProgress(
  status: GalleryUploadTask["status"],
  totalFiles: number,
  uploaded: number,
  failed: number,
  message: string,
): GalleryUploadTask {
  const now = new Date().toISOString();
  return {
    id: "direct-upload",
    status,
    totalFiles,
    totalBytes: 0,
    uploaded,
    failed,
    processed: Math.min(totalFiles, uploaded + failed),
    message,
    createdAt: now,
    updatedAt: now,
    assets: [],
    errors: [],
  };
}

function directUploadFailureResult(
  prepared: DirectUploadPreparedItem[],
  errors: DirectUploadPrepareResult["errors"],
): BatchUploadAssetsResult {
  return {
    ok: false,
    uploaded: 0,
    failed: prepared.length,
    assets: [],
    errors: errors.length > 0
      ? errors.map((item) => ({ filename: item.filename, message: item.message }))
      : prepared.map((item) => ({ filename: item.filename, message: "直传准备失败" })),
  };
}

function normalizeDirectCompleteErrors(errors: BatchUploadAssetsResult["errors"]) {
  return errors.map((item) => ({
    filename: item.filename,
    message: item.message,
  }));
}

function fileDisplayName(file: File) {
  return file.webkitRelativePath || file.name || "image";
}

function uploadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function uploadAssetsLegacy(baseUrl: string, files: File[], productImageRuleId?: string) {
  const token = getCloudToken();
  const form = new FormData();
  if (productImageRuleId) {
    form.append("productImageRuleId", productImageRuleId);
  }
  for (const file of files) {
    form.append("files", file);
  }
  const response = await fetch(`${baseUrl}/gallery/assets/batch-upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "云图库批量上传失败");
  }
  return data as BatchUploadAssetsResult;
}

async function createBatchUploadTask(baseUrl: string, files: File[], productImageRuleId?: string) {
  const token = getCloudToken();
  const form = new FormData();
  if (productImageRuleId) {
    form.append("productImageRuleId", productImageRuleId);
  }
  for (const file of files) {
    form.append("files", file);
  }
  const response = await fetch(`${baseUrl}/gallery/assets/batch-upload-task`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "云图库批量上传任务创建失败");
  }
  return (data as { ok: boolean; task: GalleryUploadTask }).task;
}

async function waitForBatchUploadTask(
  baseUrl: string,
  taskId: string,
  onProgress?: (task: GalleryUploadTask) => void,
) {
  let pollIndex = 0;
  const pollDelays = [1500, 3000, 5000, 10_000];
  while (true) {
    const result = await request<{ ok: boolean; task: GalleryUploadTask }>(
      baseUrl,
      `/gallery/upload-tasks/${encodeURIComponent(taskId)}`,
      { auth: true, timeoutMs: 30_000 },
    );
    onProgress?.(result.task);
    if (isFinishedUploadTaskStatus(result.task.status)) {
      return result.task;
    }
    await sleep(pollDelays[Math.min(pollIndex, pollDelays.length - 1)]);
    pollIndex += 1;
  }
}

function isFinishedUploadTaskStatus(status: GalleryUploadTask["status"]) {
  return status === "succeeded" || status === "partial" || status === "failed";
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function downloadAssetOriginal(baseUrl: string, assetId: string) {
  const token = getCloudToken();
  const response = await fetch(`${baseUrl}/gallery/assets/${encodeURIComponent(assetId)}/original`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw createApiError(response, data, "原图下载失败");
  }
  return response.blob();
}

async function uploadLocalMockupResult(baseUrl: string, input: UploadLocalMockupResultInput) {
  const token = getCloudToken();
  const form = new FormData();
  form.append("sceneIndex", String(input.sceneIndex));
  form.append("filename", input.filename);
  if (input.clientRenderer?.trim()) {
    form.append("clientRenderer", input.clientRenderer.trim());
  }
  form.append("file", input.blob, input.filename);
  const response = await fetch(`${baseUrl}/mockups/${encodeURIComponent(input.templateId)}/assets/${encodeURIComponent(input.sourceAssetId)}/local-result`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "本地套图上传失败");
  }
  return data as UploadLocalMockupResult;
}

function createApiError(response: Response, data: unknown, fallback: string) {
  const body = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
  const issueDetails = formatApiIssues(body.issues);
  const rawMessage = typeof body.message === "string" ? body.message : "";
  const baseMessage = normalizePublicApiMessage(rawMessage)
    || (response.status === 503
      ? "云服务数据库正在启动或临时繁忙，请稍后刷新重试"
      : "")
    || (rawMessage
      ? rawMessage
      : response.status === 413
        ? `${fallback}：上传批次过大，请减少单批图片数量或压缩图片后重试`
        : `${fallback}：HTTP ${response.status}`);
  const message = issueDetails && !baseMessage.includes("：")
    ? `${baseMessage}：${issueDetails}`
    : baseMessage;
  const code = typeof body.code === "string" ? body.code : undefined;
  return new CloudApiError(message, response.status, code);
}

function normalizePublicApiMessage(message: string) {
  const text = message.toLowerCase();
  if (
    text.includes("the database system is not yet accepting connections")
    || text.includes("the database system is starting up")
    || text.includes("database system is shutting down")
    || text.includes("connection terminated unexpectedly")
    || text.includes("terminating connection")
    || text.includes("connect econnrefused")
    || text.includes("too many clients")
  ) {
    return "云服务数据库正在启动或临时繁忙，请稍后刷新重试";
  }
  if (
    text.includes("postgres")
    || text.includes("database")
    || text.includes("connection")
  ) {
    return "云服务临时不可用，请稍后刷新重试";
  }
  return "";
}

type ApiIssue = {
  path?: unknown;
  code?: unknown;
  message?: unknown;
  validation?: unknown;
  minimum?: unknown;
  maximum?: unknown;
};

function formatApiIssues(value: unknown) {
  if (!Array.isArray(value)) return "";
  const issues = value.slice(0, 3).map((item) => formatApiIssue(item)).filter(Boolean);
  const more = value.length > issues.length ? `；还有 ${value.length - issues.length} 个参数问题` : "";
  return `${issues.join("；")}${more}`;
}

function formatApiIssue(value: unknown) {
  const issue = typeof value === "object" && value !== null ? value as ApiIssue : {};
  const path = Array.isArray(issue.path)
    ? issue.path.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    : [];
  const field = apiIssueFieldLabel(path);
  const reason = apiIssueReason(issue);
  return `${field}${reason}`;
}

function apiIssueReason(issue: ApiIssue) {
  if (issue.code === "invalid_string" && issue.validation === "uuid") {
    return "格式不正确，需要是系统生成的 ID";
  }
  if (issue.code === "invalid_string" && issue.validation === "regex") {
    return "格式不正确";
  }
  if (issue.code === "too_small") {
    const minimum = typeof issue.minimum === "number" ? issue.minimum : 0;
    return minimum > 1 ? `至少需要 ${minimum} 项` : "不能为空";
  }
  if (issue.code === "too_big") {
    const maximum = typeof issue.maximum === "number" ? issue.maximum : 0;
    return maximum ? `不能超过 ${maximum} 个字符或项目` : "超过允许长度";
  }
  if (issue.code === "invalid_enum_value") {
    return "不是可选值";
  }
  if (issue.code === "invalid_type") {
    return "类型不正确";
  }
  return typeof issue.message === "string" ? `：${issue.message}` : "不正确";
}

function apiIssueFieldLabel(path: Array<string | number>) {
  const text = formatApiIssuePath(path);
  const keys = path.filter((item): item is string => typeof item === "string");
  const last = keys[keys.length - 1] ?? text;
  const parent = keys[0] ?? "";
  const common: Record<string, string> = {
    ratioFamily: "图片比例",
    mockupTemplateId: "样机 ID",
    mockupTemplateName: "样机名称",
    titlePromptTemplateId: "标题提示词模板 ID",
    titlePromptTemplateName: "标题提示词模板名称",
    titlePrompt: "标题提示词",
    shopTargets: "上架店铺",
    assets: "上架图片",
  };
  const shop: Record<string, string> = {
    externalShopId: "店铺 ID",
    id: "商品模板 ID",
    name: "商品模板名称",
    externalTemplateId: "外部商品模板 ID",
    categoryLabel: "类目说明",
  };
  const asset: Record<string, string> = {
    sourceAssetId: "原图 ID",
    externalShopId: "图片分配店铺",
    imageAssetIds: "套图 ID",
    title: "商品标题",
  };
  const label = parent === "shopTargets" ? shop[last] : parent === "assets" ? asset[last] : common[last];
  return text ? `${label ?? text}(${text})` : label ?? "请求参数";
}

function formatApiIssuePath(path: Array<string | number>) {
  return path.reduce((text, item) => {
    if (typeof item === "number") {
      return `${text}[${item + 1}]`;
    }
    return text ? `${text}.${item}` : item;
  }, "");
}

function galleryQueryString(query: GalleryQuery | FeaturedGalleryQuery) {
  const params = new URLSearchParams();
  if (query.ratioFamily) params.set("ratioFamily", query.ratioFamily);
  if (query.productImageRuleId) params.set("productImageRuleId", query.productImageRuleId);
  if (query.keyword) params.set("keyword", query.keyword);
  if ("externalShopId" in query && query.externalShopId) params.set("externalShopId", query.externalShopId);
  if ("excludeAssetIds" in query && query.excludeAssetIds?.length) params.set("excludeAssetIds", query.excludeAssetIds.join(","));
  if ("hideUsed" in query && query.hideUsed !== undefined) params.set("hideUsed", String(query.hideUsed));
  if ("listingStatus" in query && query.listingStatus) params.set("listingStatus", query.listingStatus);
  if ("mockupTemplateId" in query && query.mockupTemplateId) params.set("mockupTemplateId", query.mockupTemplateId);
  if ("mockupStatus" in query && query.mockupStatus) params.set("mockupStatus", query.mockupStatus);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.offset) params.set("offset", String(query.offset));
  if (query.includeTotal !== undefined) params.set("includeTotal", String(query.includeTotal));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function listingImageRepairQueryString(query: ListingImageRepairQuery) {
  const params = new URLSearchParams();
  if (query.externalShopId) params.set("externalShopId", query.externalShopId);
  if (query.keyword) params.set("keyword", query.keyword);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.offset) params.set("offset", String(query.offset));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function dailyListingStatsQueryString(query: DailyListingStatsQuery) {
  const params = new URLSearchParams();
  if (query.dateFrom) params.set("dateFrom", query.dateFrom);
  if (query.dateTo) params.set("dateTo", query.dateTo);
  if (query.externalShopId) params.set("externalShopId", query.externalShopId);
  const text = params.toString();
  return text ? `?${text}` : "";
}
