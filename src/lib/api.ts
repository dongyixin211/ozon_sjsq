import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  BatchUploadRequest,
  CategoryOption,
  JobKind,
  JobLog,
  JobSummary,
  ListedUpdateRequest,
  LocalSceneRequest,
  MaterialsRequest,
  OrderDocumentsRequest,
  OzonProductRow,
  PreflightIssue,
  ProviderSecretDraft,
  ProviderSecretStatus,
  Shop,
  ShopDraft,
  TemplateDraft,
  TemplateSummary,
  WarehouseOption,
} from "@shared/types";

export interface AppSnapshot {
  settings: AppSettings;
  shops: Shop[];
  jobs: JobSummary[];
  providerSecrets: ProviderSecretStatus;
}

const defaultSettings: AppSettings = {
  defaultSourceRoot: "",
  defaultOutputRoot: "",
  watermarkPath: "",
  contentRoot: "",
  uploadExcelPath: "",
  uploadMaxItems: 100,
  listedUpdateMaxWorkers: 2,
  imageProvider: "xiaoqian",
  textProvider: "wenwen",
  imageBaseUrl: "https://xiaoqian.art/v1",
  textBaseUrl: "https://breakout.wenwen-ai.com/v1",
  imageModel: "gpt-image-2",
  textModel: "gpt-5-high",
  maxWorkers: 3,
  maxFolders: 0,
  exportExcel: true,
  convertOriginals: true,
  generateCopy: false,
  quality: "high",
  sceneSourceRoot: "",
  sceneOutputRoot: "",
  sceneMockupRoot: "",
  sceneSingleImage: "",
  sceneAspectRatio: "1:1",
  sceneCount: 8,
  sceneMaxWorkers: 2,
  sceneMaxFolders: 0,
  sceneSizeLabel: "",
  scenePromptTemplate: "",
  imagePromptTemplate: "",
  titlePromptTemplate: "",
  descriptionPromptTemplate: "",
  selectedTemplateName: "",
};

const mockJobs: JobSummary[] = [
  {
    id: "mock-1",
    kind: "batch_upload",
    title: "示例：批量上架任务",
    status: "succeeded",
    progress: 100,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const isTauri = "__TAURI_INTERNALS__" in window;

async function call<T>(command: string, args?: Record<string, unknown>, fallback?: () => T): Promise<T> {
  if (isTauri) {
    return invoke<T>(command, args);
  }
  if (fallback) return fallback();
  throw new Error(`命令 ${command} 需要在 Tauri 应用内运行`);
}

export const api = {
  loadAppState: () =>
    call<AppSnapshot>("load_app_state", undefined, () => ({
      settings: defaultSettings,
      shops: [],
      jobs: mockJobs,
      providerSecrets: { imageApiKeyStored: false, textApiKeyStored: false },
    })),
  saveSettings: (settings: AppSettings) => call<AppSettings>("save_settings", { settings }, () => settings),
  saveProviderSecrets: (settings: AppSettings, draft: ProviderSecretDraft) =>
    call<ProviderSecretStatus>("save_provider_secrets", { settings, draft }, () => ({
      imageApiKeyStored: Boolean(draft.imageApiKey),
      textApiKeyStored: Boolean(draft.textApiKey),
    })),
  saveShop: (draft: ShopDraft) =>
    call<Shop>("save_shop", { draft }, () => ({
      id: draft.id ?? crypto.randomUUID(),
      name: draft.name,
      clientId: draft.clientId,
      apiKeyStored: Boolean(draft.apiKey),
      ossAccessKeyId: draft.ossAccessKeyId,
      ossAccessKeyStored: Boolean(draft.ossAccessKeySecret),
      ossBucket: draft.ossBucket,
      ossEndpoint: draft.ossEndpoint,
      ossPublicDomain: draft.ossPublicDomain,
      enabled: draft.enabled,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  deleteShop: (id: string) => call<void>("delete_shop", { id }, () => undefined),
  listTemplates: (kind: string) =>
    call<TemplateSummary[]>("list_templates", { kind }, () => []),
  saveTemplate: (draft: TemplateDraft) =>
    call<TemplateSummary>("save_template", { draft }, () => ({
      id: draft.id ?? crypto.randomUUID(),
      kind: draft.kind,
      name: draft.name,
      payload: draft.payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  deleteTemplate: (id: string) => call<void>("delete_template", { id }, () => undefined),
  testOzonConnection: (shopId: string) =>
    call<unknown>("test_ozon_connection", { shopId }, () => ({ result: { items: [] }, mock: true })),
  testOssUpload: (shopId: string) =>
    call<string>("test_oss_upload", { shopId }, () => `https://example.com/healthcheck/${shopId}.txt`),
  listOzonProducts: (shopId: string, visibility?: string, limit?: number) =>
    call<OzonProductRow[]>(
      "list_ozon_products",
      { shopId, visibility: visibility ?? "", limit: limit ?? 50 },
      () => [
        { productId: 1001, offerId: "SKU001", name: "示例商品", visibility, hasBarcode: false, stockSummary: "全仓 0" },
      ],
    ),
  listCategories: (shopId: string) =>
    call<CategoryOption[]>(
      "list_categories",
      { shopId },
      () => [
        { id: 17028922, name: "服饰配件", level: 0, nodeKind: "category", descriptionCategoryId: 17028922 },
        { id: 17028923, name: "围巾/方巾", level: 1, parentId: 17028922, nodeKind: "type", descriptionCategoryId: 17028922, typeId: 17028923 },
        { id: 17028924, name: "发饰", level: 1, parentId: 17028922, nodeKind: "category", descriptionCategoryId: 17028924 },
        { id: 17028925, name: "束发带", level: 2, parentId: 17028924, nodeKind: "type", descriptionCategoryId: 17028924, typeId: 17028925 },
      ],
    ),
  listProductsByCategory: (shopId: string, categoryId: number, typeId?: number, limit?: number) =>
    call<OzonProductRow[]>(
      "list_products_by_category",
      { shopId, categoryId, typeId, limit: limit ?? 100 },
      () => [
        {
          productId: 1001,
          offerId: "SKU001",
          name: "示例商品",
          categoryId,
          categoryName: typeId ? "发饰" : "围巾/方巾",
          typeId,
          typeName: typeId ? "束发带" : undefined,
          price: "999",
          oldPrice: "1299",
          currencyCode: "RUB",
          hasBarcode: true,
          stockSummary: "示例仓库:5",
        },
      ],
    ),
  getProductInfo: (shopId: string, offerIds: string[]) =>
    call<unknown>("get_product_info", { shopId, offerIds }, () => ({ result: { items: [] } })),
  getProductInfoByProductIds: (shopId: string, productIds: number[]) =>
    call<unknown>("get_product_info_by_product_ids", { shopId, productIds }, () => ({
      result: {
        items: productIds.map((productId) => ({
          product_id: productId,
          offer_id: `SKU-${productId}`,
          name: "示例活动商品",
          primary_image: "https://example.com/image-1.jpg",
          currency_code: "RUB",
          price: "999",
        })),
      },
    })),
  getProductAttributes: (shopId: string, offerIds: string[]) =>
    call<unknown>("get_product_attributes", { shopId, offerIds }, () => ({ result: [] })),
  getProductStocks: (shopId: string, productIds: number[]) =>
    call<unknown>("get_product_stocks", { shopId, productIds }, () => ({ result: { items: [] } })),
  importProducts: (shopId: string, items: unknown[]) =>
    call<unknown>("import_products", { shopId, items }, () => ({ result: { task_id: "mock-task" } })),
  listActions: (shopId: string) =>
    call<unknown>("list_actions", { shopId }, () => ({
      result: [
        { id: 1, title: "示例活动", date_start: new Date().toISOString(), date_end: new Date().toISOString() },
      ],
    })),
  listActionProducts: (shopId: string, actionId: number, limit?: number, lastId?: string) =>
    call<unknown>(
      "list_action_products",
      { shopId, actionId, limit: limit ?? 100, lastId: lastId ?? "" },
      () => ({ result: { products: [], last_id: "" } }),
    ),
  activateActionProducts: (shopId: string, actionId: number, products: unknown[]) =>
    call<unknown>("activate_action_products", { shopId, actionId, products }, () => ({ result: products })),
  deactivateActionProducts: (shopId: string, actionId: number, productIds: number[]) =>
    call<unknown>("deactivate_action_products", { shopId, actionId, productIds }, () => ({ result: productIds })),
  buildImportPreview: (input: {
    templateProduct: unknown;
    offerId: string;
    title: string;
    description: string;
    imageUrls: string[];
    videoLinks: string[];
    richJson?: string;
  }) =>
    call<unknown>("build_import_preview", { input }, () => ({
      ...(typeof input.templateProduct === "object" && input.templateProduct ? input.templateProduct : {}),
      offer_id: input.offerId,
      name: input.title,
      description: input.description,
      images: input.imageUrls,
      primary_image: input.imageUrls[0],
    })),
  listWarehouses: (shopId: string) =>
    call<WarehouseOption[]>("list_warehouses", { shopId }, () => [{ warehouseId: 1, name: "示例仓库" }]),
  getImportInfo: (shopId: string, taskId: number) =>
    call<unknown>("get_import_info", { shopId, taskId }, () => ({ result: { status: "mock" } })),
  updateStocks: (shopId: string, stocks: Array<Record<string, unknown>>) =>
    call<unknown>("update_stocks", { shopId, stocks }, () => ({ result: stocks.map((stock) => ({ ...stock, updated: true })) })),
  updatePrices: (shopId: string, prices: Array<Record<string, unknown>>) =>
    call<unknown>("update_prices", { shopId, prices }, () => ({ result: prices.map((price) => ({ ...price, updated: true })) })),
  generateBarcodes: (shopId: string, productIds: number[]) =>
    call<unknown>("generate_barcodes", { shopId, productIds }, () => ({ result: productIds.map((productId) => ({ productId })) })),
  startDemoJob: (kind: JobKind, title: string) =>
    call<JobSummary>("start_demo_job", { kind, title }, () => ({
      id: crypto.randomUUID(),
      kind,
      title,
      status: "running",
      progress: 30,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  startBatchUpload: (request: BatchUploadRequest) =>
    call<JobSummary>("start_batch_upload", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "batch_upload",
      title: "多店铺批量上架",
      status: "running",
      progress: 5,
      inputPath: request.excelPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  startListedUpdate: (request: ListedUpdateRequest) =>
    call<JobSummary>("start_listed_update", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "listed_update",
      title: "按货号更新已上架商品",
      status: "running",
      progress: 5,
      inputPath: request.excelPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  startOrderDocuments: (request: OrderDocumentsRequest) =>
    call<JobSummary>("start_order_documents", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "order_documents",
      title: "订单文件下载",
      status: "running",
      progress: 5,
      inputPath: request.orderNumbers.join(","),
      outputPath: request.outputRoot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  startMaterialsJob: (request: MaterialsRequest) =>
    call<JobSummary>("start_materials_job", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "materials",
      title: "素材生成与 3:4 转图",
      status: "running",
      progress: 5,
      inputPath: request.sourceRoot,
      outputPath: request.portraitRoot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  preflightMaterials: (request: MaterialsRequest) =>
    call<PreflightIssue[]>("preflight_materials", { request }, () => [
      { level: "info", scope: "预检查", message: "浏览器预览模式：桌面端会检查目录、AI Key 和预计处理量。" },
    ]),
  preflightBatchUpload: (request: BatchUploadRequest) =>
    call<PreflightIssue[]>("preflight_batch_upload", { request }, () => [
      { level: "info", scope: "预检查", message: "浏览器预览模式：桌面端会检查店铺、OSS、Excel 和 SKU 图片匹配。" },
    ]),
  preflightListedUpdate: (request: ListedUpdateRequest) =>
    call<PreflightIssue[]>("preflight_listed_update", { request }, () => [
      { level: "info", scope: "预检查", message: "浏览器预览模式：桌面端会检查店铺、Excel、更新项和线上商品连接。" },
    ]),
  startLocalSceneJob: (request: LocalSceneRequest) =>
    call<JobSummary>("start_local_scene_job", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "scene_local",
      title: "本地场景图合成",
      status: "running",
      progress: 5,
      inputPath: request.sourceRoot,
      outputPath: request.outputRoot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  listJobs: () => call<JobSummary[]>("list_jobs", undefined, () => mockJobs),
  listJobLogs: (jobId: string) =>
    call<JobLog[]>("list_job_logs", { jobId }, () => [
      { id: "log-1", jobId, level: "info", message: "示例日志", createdAt: new Date().toISOString() },
    ]),
  cancelJob: (jobId: string) => call<boolean>("cancel_job", { jobId }, () => true),
  createUploadTemplate: (path: string) => call<void>("create_upload_template", { path }, () => undefined),
  analyzeSkuFolder: (path: string) =>
    call<{ root: string; skuCount: number; imageCount: number; rows: Array<{ sku: string; imageCount: number; firstImage?: string }> }>(
      "analyze_sku_folder",
      { path },
      () => ({ root: path, skuCount: 0, imageCount: 0, rows: [] }),
    ),
  openPath: (path: string) => call<void>("open_path", { path }, () => undefined),
  openUrl: (url: string) => call<void>("open_url", { url }, () => {
    window.open(url, "_blank", "noopener,noreferrer");
  }),
};
