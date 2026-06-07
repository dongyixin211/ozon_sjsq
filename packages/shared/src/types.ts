export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobKind =
  | "materials"
  | "scene_local"
  | "scene_ai"
  | "batch_upload"
  | "listed_update"
  | "inventory"
  | "barcode"
  | "order_documents"
  | "api_test";

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
  enabled: boolean;
}

export interface AppSettings {
  defaultSourceRoot: string;
  defaultOutputRoot: string;
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
}

export interface ProviderSecretStatus {
  imageApiKeyStored: boolean;
  textApiKeyStored: boolean;
}

export interface ProviderSecretDraft {
  imageApiKey?: string;
  textApiKey?: string;
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
}

export interface OrderDocumentsRequest {
  shopId: string;
  orderNumbers: string[];
  outputRoot: string;
  ozonCompanyId?: string;
  ozonSellerHarPath?: string;
  ozonSellerCookiePath?: string;
  baiduCookiePath?: string;
  baiduSearchDir?: string;
  baiduRecursive: boolean;
  downloadMaterials: boolean;
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
}

export interface LocalSceneRequest {
  sourceRoot: string;
  outputRoot: string;
  mockupRoot?: string;
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
