export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobKind =
  | "materials"
  | "scene_local"
  | "scene_ai"
  | "local_mockup"
  | "auto_listing"
  | "gallery_upload"
  | "batch_upload"
  | "listing_image_repair"
  | "listed_update"
  | "follow_sync"
  | "follow_automation"
  | "listing_maintenance"
  | "inventory"
  | "barcode"
  | "order_documents"
  | "api_test";

export type ShopRole = "main" | "follower";

export interface Shop {
  id: string;
  name: string;
  clientId: string;
  apiKeyStored: boolean;
  apiKeyPlain?: string;
  ossAccessKeyId?: string;
  ossAccessKeyStored: boolean;
  ossSecretPlain?: string;
  ossBucket?: string;
  ossEndpoint?: string;
  ossPublicDomain?: string;
  watermarkPath?: string;
  shopRole?: ShopRole;
  followsShopId?: string;
  followWarehouseId?: number;
  maintenanceWarehouseId?: number;
  maintenanceStock?: number;
  maintenanceStockEnabled?: boolean;
  maintenanceBarcodeEnabled?: boolean;
  maintenanceActionEnabled?: boolean;
  maintenanceIntervalMinutes?: number;
  maintenanceActionConfigs?: ListingMaintenanceActionConfig[];
  ozonSellerCookieStored: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShopDraft {
  id?: string;
  name: string;
  clientId: string;
  apiKey?: string;
  ossAccessKeyId?: string;
  ossAccessKeySecret?: string;
  ossBucket?: string;
  ossEndpoint?: string;
  ossPublicDomain?: string;
  watermarkPath?: string;
  shopRole?: ShopRole;
  followsShopId?: string;
  followWarehouseId?: number;
  maintenanceWarehouseId?: number;
  maintenanceStock?: number;
  maintenanceStockEnabled?: boolean;
  maintenanceBarcodeEnabled?: boolean;
  maintenanceActionEnabled?: boolean;
  maintenanceIntervalMinutes?: number;
  maintenanceActionConfigs?: ListingMaintenanceActionConfig[];
  enabled: boolean;
}

export interface ListingMaintenanceActionConfig {
  categoryId: number;
  categoryName?: string;
  actionId: number;
  actionTitle?: string;
  actionPrice: string;
  actionStock: number;
}

export interface AppSettings {
  cloudApiBaseUrl: string;
  defaultSourceRoot: string;
  defaultOutputRoot: string;
  baiduCookie: string;
  watermarkPath: string;
  contentRoot: string;
  uploadExcelPath: string;
  uploadMaxItems: number;
  listedUpdateMaxWorkers: number;
  imageProvider: string;
  textProvider: string;
  imageBaseUrl: string;
  textBaseUrl: string;
  imageModel: string;
  textModel: string;
  maxWorkers: number;
  maxFolders: number;
  exportExcel: boolean;
  convertOriginals: boolean;
  generateCopy: boolean;
  quality: string;
  sceneSourceRoot: string;
  sceneOutputRoot: string;
  sceneMockupRoot: string;
  sceneSingleImage: string;
  sceneAspectRatio: string;
  sceneCount: number;
  sceneMaxWorkers: number;
  sceneMaxFolders: number;
  sceneSizeLabel: string;
  scenePromptTemplate: string;
  imagePromptTemplate: string;
  titlePromptTemplate: string;
  descriptionPromptTemplate: string;
  selectedTemplateName: string;
  materialPortraitSourceRoot: string;
  materialPortraitOutputRoot: string;
  materialPortraitMaxItems: number;
  materialTitleSourceRoot: string;
  materialTitleOutputRoot: string;
  materialTitleMaxItems: number;
  materialRenameSourceRoot: string;
  materialRenameOutputRoot: string;
  materialRenamePrefix: string;
}

export interface ProviderSecretStatus {
  imageApiKeyStored: boolean;
  textApiKeyStored: boolean;
}

export interface ProviderSecretDraft {
  imageApiKey?: string;
  textApiKey?: string;
}

export interface AiSettingsPublic {
  imageProvider: string;
  imageBaseUrl: string;
  imageModel: string;
  imageApiKeyStored: boolean;
  imageApiKeyMasked?: string;
  textProvider: string;
  textBaseUrl: string;
  textModel: string;
  textApiKeyStored: boolean;
  textApiKeyMasked?: string;
  imagePromptTemplate: string;
  titlePromptTemplate: string;
  descriptionPromptTemplate: string;
  updatedAt: string;
}

export interface CloudUser {
  id: string;
  phone: string;
  displayName?: string | null;
  role: "member" | "beta" | "admin";
  membershipPlan?: string | null;
  membershipExpiresAt?: string | null;
  galleryStorageUsedBytes?: number;
  galleryStorageLimitBytes?: number;
  /** 用户可访问的功能标识列表。admin 返回 ["*"]，beta 返回全部活跃功能，member 返回个人授权的功能 */
  features?: string[];
}

export interface CloudAsset {
  id: string;
  sku: string;
  sha256: string;
  ratio: number;
  ratioFamily: "portrait" | "square" | "landscape" | "wide";
  productImageRuleId?: string | null;
  productType?: string | null;
  aspectRatio?: string | null;
  width: number;
  height: number;
  publicUrl: string;
  thumbUrl?: string | null;
  contentType: string;
  sizeBytes: number;
  sourceFilename: string;
  createdAt: string;
  generatedTitle?: string | null;
  generatedTitleImageAssetId?: string | null;
  generatedTitlePrompt?: string | null;
  generatedTitleUpdatedAt?: string | null;
  score?: number;
  orderCount?: number;
  distinctUserCount?: number;
  distinctShopCount?: number;
  lastOrderedAt?: string | null;
  reason?: string | null;
  mockupResults?: CloudMockupAsset[];
  listingStatus?: CloudListingStatus | null;
}

export interface CloudMockupAsset extends CloudAsset {
  templateId: string;
  templateName: string;
  sceneIndex: number;
}

export interface CloudMockupTemplate {
  id: string;
  templateId?: string;
  name: string;
  description?: string;
  productType?: string;
  sourceAspectRatio?: string;
  status?: "system" | "custom" | "draft";
  previewUrl?: string;
  sceneCount: number;
  outputWidth: number;
  outputHeight: number;
}

export interface CloudProductImageRule {
  id: string;
  productType: string;
  aspectRatio: string;
  ratioWidth: number;
  ratioHeight: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OzonUploadQuota {
  dailyCreateLimit: number;
  dailyCreateUsage: number;
  dailyCreateRemaining: number;
  dailyUpdateLimit: number;
  dailyUpdateUsage: number;
  dailyUpdateRemaining: number;
  totalLimit: number;
  totalUsage: number;
  totalRemaining: number;
  resetAt?: string | null;
  operationLimits?: unknown;
  fetchedAt: string;
}

export type AutoListingAssignmentStatus =
  | "reserved"
  | "preparing"
  | "ready"
  | "submitting"
  | "completed"
  | "failed"
  | "paused"
  | "released";

export type AutoListingRunStatus =
  | "waiting"
  | "preparing"
  | "submitting"
  | "completed"
  | "failed"
  | "paused";

export interface AutoListingPlanShopConfig {
  externalShopId: string;
  shopName: string;
  localShopId: string;
  localTemplateId: string;
  productTemplateId: string;
  productTemplateName: string;
  templateProduct: unknown;
  autoGenerateBarcode: boolean;
  autoUpdateStock: boolean;
  autoAddToAction: boolean;
}

export interface CloudAutoListingPlan {
  id: string;
  name: string;
  productImageRuleId: string;
  mockupTemplateId: string;
  mockupTemplateName: string;
  titlePromptTemplateId?: string | null;
  titlePromptTemplateName?: string | null;
  titlePrompt: string;
  shopConfigs: AutoListingPlanShopConfig[];
  startMinute: number;
  endMinute: number;
  batchSize: number;
  bufferSize: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CloudAutoListingRun {
  id: string;
  planId: string;
  runDate: string;
  sequence: number;
  status: AutoListingRunStatus;
  quotaSnapshot: unknown;
  planSnapshot: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CloudAutoListingAssignment {
  id: string;
  planId: string;
  runId: string;
  sourceAssetId: string;
  externalShopId: string;
  planSnapshot: unknown;
  shopSnapshot: unknown;
  batchId?: string | null;
  status: AutoListingAssignmentStatus;
  retryCount: number;
  lastError?: string | null;
  releasedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveAutoListingBatchInput {
  planId: string;
  quotaByExternalShopId: Record<string, OzonUploadQuota>;
}

export interface ReserveAutoListingBatchResult {
  run: CloudAutoListingRun;
  assignments: CloudAutoListingAssignment[];
}

export interface LocalMockupRenderAssetInput {
  id: string;
  sku: string;
  sourceFilename?: string;
  publicUrl?: string;
}

export interface LocalMockupRenderRequest {
  cloudApiBaseUrl?: string;
  cloudAuthToken?: string;
  templateId: string;
  templateName?: string;
  assets: LocalMockupRenderAssetInput[];
  maxWorkers?: number;
}

export interface LocalMockupRenderItemResult {
  sourceAssetId: string;
  sourceSku: string;
  ok: boolean;
  assets: CloudMockupAsset[];
  error?: string;
}

export interface LocalMockupRenderResult {
  ok: boolean;
  templateId: string;
  templateName: string;
  generated: number;
  successCount: number;
  failedCount: number;
  items: LocalMockupRenderItemResult[];
}

export interface LocalMockupProgressItem {
  sourceAssetId: string;
  sourceSku: string;
  error?: string;
}

export interface LocalMockupProgress {
  total: number;
  workerCount: number;
  started: number;
  completed: number;
  failed: number;
  queued: number;
  active: number;
  running: LocalMockupProgressItem[];
  completedAssetIds: string[];
  failedItems: LocalMockupProgressItem[];
}

export interface CloudTitlePromptTemplate {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudProductTemplateRef {
  id: string;
  name: string;
}

export interface CloudListingImageSet {
  externalShopId: string;
  shopName: string;
  productTemplateName: string;
  sourceAssetId: string;
  sourceSku: string;
  sourceUrl: string;
  sourceThumbUrl?: string | null;
  imageAssetIds: string[];
  imageUrls: string[];
  title?: string | null;
  configSnapshot?: CloudListingConfigSnapshot | null;
  stageProgress?: CloudListingStageProgress | null;
  progress?: number;
  stage?: string | null;
  stageMessage?: string | null;
  productId?: number | null;
  completedAt?: string | null;
}

export interface CloudListingShopTarget {
  externalShopId: string;
  shopName: string;
  productTemplateId: string;
  productTemplateName: string;
  status: "prepared" | "uploaded" | "failed";
  uploadedAt?: string | null;
  error?: string | null;
  configSnapshot?: CloudListingConfigSnapshot | null;
}

export interface CloudListingConfigSnapshot {
  externalShopId: string;
  shopName?: string;
  localShopId?: string;
  localTemplateId?: string;
  localTemplateName?: string;
  productTemplateId?: string;
  productTemplateName?: string;
  templateProduct?: unknown;
  templateVideoLinks?: string[];
  uploadTemplateVideo?: boolean;
  autoGenerateBarcode?: boolean;
  autoUpdateStock?: boolean;
  autoAddToAction?: boolean;
  autoWarehouseId?: number;
  autoStock?: number;
  autoActionId?: number;
  autoActionPrice?: string;
  autoActionStock?: number;
  postListingDelayMinutes?: number;
  actionDelayMinutes?: number;
  actionRetryCount?: number;
  actionRetryIntervalMinutes?: number;
  dailyListingLimit?: number;
}

export interface CloudListingStageProgress {
  mockup?: CloudListingStageState;
  title?: CloudListingStageState;
  listing?: CloudListingStageState;
  stock?: CloudListingStageState;
  barcode?: CloudListingStageState;
  action?: CloudListingStageState;
  workflow?: CloudListingStageState;
  [stage: string]: CloudListingStageState | undefined;
}

export interface CloudListingStageState {
  status?: "queued" | "running" | "waiting" | "done" | "failed" | "skipped" | string;
  progress?: number;
  done?: number;
  total?: number;
  message?: string;
  productId?: number | null;
  updatedAt?: string;
}

export interface CloudListingBatch {
  id: string;
  status: "prepared" | "uploaded" | "failed";
  ratioFamily: CloudAsset["ratioFamily"];
  productImageRuleId?: string | null;
  productType?: string | null;
  aspectRatio?: string | null;
  mockupTemplateId: string;
  mockupTemplateName: string;
  titlePromptTemplateId?: string | null;
  titlePromptTemplateName?: string | null;
  titlePrompt?: string | null;
  imageSets: CloudListingImageSet[];
  shopTargets: CloudListingShopTarget[];
  createdAt: string;
  updatedAt: string;
}

export interface CloudListingStatus {
  batchId: string;
  status: CloudListingBatch["status"];
  title?: string | null;
  uploadedAt?: string | null;
  stage?: string | null;
  progress?: number;
  stageMessage?: string | null;
  stageProgress?: CloudListingStageProgress | null;
  productId?: number | null;
  completedAt?: string | null;
  shops: Array<{
    externalShopId: string;
    shopName: string;
    productTemplateName: string;
    status: CloudListingShopTarget["status"];
    stage?: string | null;
    progress?: number;
    stageMessage?: string | null;
  }>;
}

export interface ShopDailyListingStat {
  externalShopId: string;
  shopName: string;
  date: string;
  listedCount: number;
  reservedCount?: number;
  pendingCount?: number;
  firstListedAt?: string | null;
  lastListedAt?: string | null;
}

export interface CloudListingReconciliationSummary {
  dateFrom: string;
  dateTo: string;
  total: number;
  completedCount: number;
  failedCount: number;
  processingCount: number;
  mockupRunningCount: number;
  titleRunningCount: number;
  listingRunningCount: number;
  shops: CloudListingShopProgress[];
  batches: CloudListingBatchProgressSummary[];
}

export interface CloudListingShopProgress {
  externalShopId: string;
  shopName: string;
  total: number;
  completedCount: number;
  failedCount: number;
  processingCount: number;
  mockupDone: number;
  mockupRunning: number;
  titleDone: number;
  titleRunning: number;
  listingDone: number;
  listingRunning: number;
  progress: number;
  currentSku?: string | null;
  currentStage?: string | null;
  currentMessage?: string | null;
  updatedAt?: string | null;
}

export interface CloudListingBatchProgressSummary {
  batchId: string;
  status: CloudListingBatch["status"];
  mockupTemplateName: string;
  total: number;
  completedCount: number;
  failedCount: number;
  processingCount: number;
  shopCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateSummary {
  id: string;
  kind: string;
  name: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDraft {
  id?: string;
  kind: string;
  name: string;
  payload: unknown;
}

export interface JobSummary {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  progress: number;
  inputPath?: string;
  outputPath?: string;
  resultPath?: string;
  resultExcelPath?: string;
  successCount?: number;
  failedCount?: number;
  lastError?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobLog {
  id: string;
  jobId: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export interface OzonProductRow {
  productId?: number;
  offerId: string;
  name: string;
  visibility?: string;
  hasBarcode?: boolean;
  stockSummary?: string;
  categoryId?: number;
  categoryName?: string;
  typeId?: number;
  typeName?: string;
  price?: string;
  oldPrice?: string;
  currencyCode?: string;
}

export interface ProductAnalyticsRow extends OzonProductRow {
  searchViews: number;
  cardViews: number;
}

export interface WarehouseOption {
  warehouseId: number;
  name: string;
}

export interface CategoryOption {
  id: number;
  name: string;
  level: number;
  parentId?: number;
  nodeKind: "category" | "type";
  descriptionCategoryId?: number;
  typeId?: number;
}

export interface ReadinessCheck {
  key: string;
  label: string;
  ready: boolean;
  detail: string;
  actionLabel?: string;
  actionTarget?: string;
}

export interface PreflightIssue {
  level: "error" | "warn" | "info";
  scope: string;
  message: string;
  actionLabel?: string;
  actionTarget?: string;
}

export interface WorkflowPreset {
  shopId?: string;
  sourceRoot?: string;
  outputRoot?: string;
  portraitRoot?: string;
  excelPath?: string;
  maxItems?: number;
}

export interface BatchUploadRequest {
  shopIds: string[];
  portraitRoot: string;
  excelPath: string;
  templateProduct: unknown;
  maxItems?: number;
  uploadTemplateVideo: boolean;
  templateVideoLinks: string[];
  autoGenerateBarcode: boolean;
  autoUpdateStock: boolean;
  autoAddToAction: boolean;
  autoWarehouseId?: number;
  autoStock?: number;
  autoActionId?: number;
  autoActionPrice?: string;
  autoActionStock?: number;
}

export interface GalleryUploadSelection {
  count: number;
  totalBytes: number;
  sampleNames: string[];
  paths: string[];
}

export interface GalleryUploadRequest {
  cloudApiBaseUrl: string;
  cloudAuthToken?: string;
  paths: string[];
  sourceLabel?: string;
  productImageRuleId?: string;
}

export interface AutoListingShopConfig {
  shopId: string;
  templateProduct: unknown;
  templateVideoLinks: string[];
  uploadTemplateVideo: boolean;
  autoGenerateBarcode: boolean;
  autoUpdateStock: boolean;
  autoAddToAction: boolean;
  autoWarehouseId?: number;
  autoStock?: number;
  autoActionId?: number;
  autoActionPrice?: string;
  autoActionStock?: number;
  postListingDelayMinutes?: number;
  actionDelayMinutes?: number;
  actionRetryCount?: number;
  actionRetryIntervalMinutes?: number;
}

export interface AutoListingItem {
  sourceAssetId: string;
  sourceSku: string;
  shopId: string;
  title: string;
  imageUrls: string[];
  productColor?: string;
  colorName?: string;
  description?: string;
  richJson?: string;
}

export interface AutoListingRequest {
  batchId?: string;
  cloudApiBaseUrl?: string;
  cloudAuthToken?: string;
  cloudExternalShopIdByShopId?: Record<string, string>;
  mockupTemplateId: string;
  mockupTemplateName: string;
  items: AutoListingItem[];
  shopConfigs: AutoListingShopConfig[];
}

export interface ListingImageRepairItem {
  batchId?: string;
  externalShopId: string;
  shopName?: string;
  sourceAssetId?: string;
  sourceSku: string;
  imageAssetIds?: string[];
  imageUrls: string[];
  uploadedAt?: string | null;
  updatedAt?: string | null;
}

export interface ListingImageRepairRequest {
  cloudApiBaseUrl?: string;
  cloudAuthToken?: string;
  items: ListingImageRepairItem[];
}

export interface ListedUpdateRequest {
  shopId: string;
  portraitRoot: string;
  excelPath: string;
  maxItems?: number;
  updateTitle: boolean;
  updateDescription: boolean;
  updateImages: boolean;
  updateVideo: boolean;
  updateRichJson: boolean;
  templateProduct?: unknown;
  templateVideoLinks: string[];
  categoryUpdate?: ListedCategoryUpdateTarget;
}

export interface ListedCategoryUpdateTarget {
  categoryId: number;
  typeId?: number;
  categoryName?: string;
  cachedProducts?: Array<Pick<OzonProductRow, "offerId" | "name">>;
}

export interface FollowAutomationRequest {
  shopId: string;
  intervalMinutes: number;
  maxFollowItems?: number;
  priceMultiplier: number;
  autoFollowSync: boolean;
  autoUpdateStock: boolean;
  autoGenerateBarcode: boolean;
  autoAddToAction: boolean;
  stock?: number;
  actionId?: number;
  actionPrice?: string;
  actionStock?: number;
}

export interface ListingMaintenanceRequest {
  shopId: string;
  intervalMinutes: number;
  autoUpdateStock: boolean;
  autoGenerateBarcode: boolean;
  autoAddToAction: boolean;
  warehouseId?: number;
  stock?: number;
  actionConfigs?: ListingMaintenanceActionConfig[];
}

export interface OrderShippingLabelAssignment {
  shopId: string;
  orderNumber: string;
  url: string;
}

export interface OrderShippingLabel {
  orderNumber: string;
  url: string;
}

export interface OrderShippingLabelDownloadRequest {
  outputRoot: string;
  assignments: OrderShippingLabelAssignment[];
}

export interface OrderDocumentsRequest {
  shopId: string;
  orderNumbers: string[];
  outputRoot: string;
  ozonCompanyId?: string;
  ozonSellerHarPath?: string;
  ozonSellerCookiePath?: string;
  baiduCookie?: string;
  baiduSearchDir?: string;
  baiduRecursive: boolean;
  downloadMaterials: boolean;
  shippingLabels: OrderShippingLabel[];
}

export interface OrderListRequest {
  shopId: string;
  dateFrom: string;
  dateTo: string;
  status?: string;
  limit?: number;
}

export interface StoredOrderQuery {
  shopIds?: string[];
  status?: string;
  keyword?: string;
  limit?: number;
}

export interface OrderPostingProduct {
  productId?: number;
  offerId: string;
  name?: string;
  quantity: number;
  price?: number;
  currencyCode?: string;
  imageUrl?: string;
}

  export interface OrderPostingRow {
    shopId?: string;
    shopName?: string;
    postingKind?: "fbs" | "fbo";
    postingNumber: string;
  orderNumber?: string;
  orderId?: number;
  status?: string;
  inProcessAt?: string;
  shipmentDate?: string;
  warehouseName?: string;
  trackingNumber?: string;
  productsCount: number;
  offerIds: string[];
  products?: OrderPostingProduct[];
  imageUrl?: string;
  salesAmount?: number;
  currencyCode?: string;
  syncedAt?: string;
  downloadedAt?: string;
  downloadOutputPath?: string;
  rawJson?: unknown;
}

export interface MaterialsRequest {
  sourceRoot: string;
  portraitRoot: string;
  contentRoot?: string;
  watermarkPath?: string;
  imageBaseUrl: string;
  textBaseUrl: string;
  imageProvider: string;
  textProvider: string;
  imageModel: string;
  textModel: string;
  imagePromptTemplate: string;
  titlePromptTemplate: string;
  descriptionPromptTemplate: string;
  generateAiImages: boolean;
  convertOriginals: boolean;
  generateCopy: boolean;
  exportExcel: boolean;
  maxItems?: number;
  cloudAuthToken?: string;
}

export interface ImageRenameRequest {
  sourceRoot: string;
  outputRoot: string;
  prefix: string;
}

export interface ImageRenameResult {
  count: number;
  outputRoot: string;
}

export interface LocalSceneRequest {
  sourceRoot: string;
  outputRoot: string;
  mockupRoot?: string;
  singleImage?: string;
  aspectRatio: string;
  sceneIds: string[];
  sizeLabel?: string;
  maxItems?: number;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
