import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AutoListingRequest,
  BatchUploadRequest,
  CategoryOption,
  FollowAutomationRequest,
  GalleryUploadRequest,
  GalleryUploadSelection,
  ImageRenameRequest,
  ImageRenameResult,
  JobKind,
  JobLog,
  JobSummary,
  ListedUpdateRequest,
  ListingImageRepairRequest,
  ListingMaintenanceRequest,
  LocalMockupRenderRequest,
  LocalMockupRenderResult,
  LocalSceneRequest,
  MaterialsRequest,
  OrderDocumentsRequest,
  OrderShippingLabelAssignment,
  OrderShippingLabelDownloadRequest,
  OrderListRequest,
  OrderPostingRow,
  OzonUploadQuota,
  OzonProductRow,
  PreflightIssue,
  ProductAnalyticsRow,
  ProviderSecretDraft,
  ProviderSecretStatus,
  Shop,
  ShopDraft,
  StoredOrderQuery,
  TemplateDraft,
  TemplateSummary,
  WarehouseOption,
} from "@shared/types";
import { getCloudToken } from "./cloudApi";

export interface AppSnapshot {
  settings: AppSettings;
  shops: Shop[];
  jobs: JobSummary[];
  providerSecrets: ProviderSecretStatus;
}

export interface UpdateCategoryProductsRequest {
  shopId: string;
  categoryId: number;
  typeId?: number;
  cachedProducts?: OzonProductRow[];
  warehouseId?: number;
  stock?: number;
  price?: string;
  oldPrice?: string;
  currencyCode?: string;
  updateStock: boolean;
  updatePrice: boolean;
}

export const defaultSettings: AppSettings = {
  cloudApiBaseUrl: "https://api.dyxtoolai.cn",
  defaultSourceRoot: "",
  defaultOutputRoot: "",
  baiduCookie: "",
  watermarkPath: "",
  contentRoot: "",
  uploadExcelPath: "",
  uploadMaxItems: 100,
  listedUpdateMaxWorkers: 2,
  imageProvider: "pixel",
  textProvider: "xiaoqian",
  imageBaseUrl: "https://ai-pixel.online/v1",
  textBaseUrl: "https://xiaoqian.art/v1",
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
  materialPortraitSourceRoot: "",
  materialPortraitOutputRoot: "",
  materialPortraitMaxItems: 0,
  materialTitleSourceRoot: "",
  materialTitleOutputRoot: "",
  materialTitleMaxItems: 0,
  materialRenameSourceRoot: "",
  materialRenameOutputRoot: "",
  materialRenamePrefix: "",
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
const LOCAL_ASSISTANT_URL = "http://127.0.0.1:17641";
const BROWSER_TEMPLATE_STORE_KEY = "ozon-sjsq:browser-templates:v1";

interface CallOptions {
  fallbackWhenUnavailable?: boolean;
}

export interface RunAutoListingPlanNowRequest {
  accountId: string;
  cloudApiBaseUrl: string;
  cloudAuthToken: string;
  planId?: string;
  force?: boolean;
}

export interface SchedulerStatusRequest {
  accountId: string;
}

export interface PauseAutoListingPlanRequest {
  accountId: string;
  planId: string;
  paused?: boolean;
}

export interface AutoListingSchedulerStatus {
  accountId: string;
  tickRunning: boolean;
  planStates: Array<{
    planId: string;
    paused: boolean;
    runId?: string;
    localJobId?: string;
    stage?: string;
    lastError?: string;
  }>;
}

async function call<T>(
  command: string,
  args?: Record<string, unknown>,
  fallback?: () => T,
  options: CallOptions = {},
): Promise<T> {
  if (isTauri) {
    return invoke<T>(command, args);
  }
  return callLocalAssistant<T>(command, args, fallback, options);
}

async function callLocalAssistant<T>(
  command: string,
  args?: Record<string, unknown>,
  fallback?: () => T,
  options: CallOptions = {},
): Promise<T> {
  try {
    const nextArgs = withCloudAuthToken(command, args);
    const response = await fetch(`${LOCAL_ASSISTANT_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, args: nextArgs }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof data.message === "string" ? data.message : `本地助手执行失败：HTTP ${response.status}`;
      throw new Error(message);
    }
    return data as T;
  } catch (error) {
    if (fallback && (import.meta.env.DEV || options.fallbackWhenUnavailable)) {
      return fallback();
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`请先打开客户端本地助手，再在浏览器操作。${message}`);
  }
}

function withCloudAuthToken(command: string, args?: Record<string, unknown>) {
  const nextArgs = { ...(args ?? {}) };
  if (
    (
      command === "start_materials_job"
      || command === "start_gallery_upload_job"
      || command === "preflight_materials"
      || command === "preflight_batch_upload"
      || command === "start_batch_upload"
      || command === "start_auto_listing"
      || command === "start_local_mockup_render"
      || command === "start_listing_image_repair"
    )
    && nextArgs.request
    && typeof nextArgs.request === "object"
  ) {
    const token = getCloudToken();
    if (token) {
      nextArgs.request = {
        ...(nextArgs.request as Record<string, unknown>),
        cloudAuthToken: token,
      };
    }
  }
  return nextArgs;
}

function listBrowserTemplates(kind: string): TemplateSummary[] {
  return readBrowserTemplates()
    .filter((template) => template.kind === kind)
    .sort((left, right) => {
      const updatedDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      return updatedDiff || left.name.localeCompare(right.name, "zh-CN");
    });
}

function saveBrowserTemplate(draft: TemplateDraft): TemplateSummary {
  const templates = readBrowserTemplates();
  const now = new Date().toISOString();
  const id = draft.id || crypto.randomUUID();
  const existing = templates.find((template) => template.id === id);
  const saved: TemplateSummary = {
    id,
    kind: draft.kind,
    name: draft.name,
    payload: draft.payload,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeBrowserTemplates([saved, ...templates.filter((template) => template.id !== id)]);
  return saved;
}

function deleteBrowserTemplate(id: string) {
  writeBrowserTemplates(readBrowserTemplates().filter((template) => template.id !== id));
}

function readBrowserTemplates(): TemplateSummary[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BROWSER_TEMPLATE_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isTemplateSummary) : [];
  } catch {
    return [];
  }
}

function writeBrowserTemplates(templates: TemplateSummary[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(BROWSER_TEMPLATE_STORE_KEY, JSON.stringify(templates));
}

function isTemplateSummary(value: unknown): value is TemplateSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TemplateSummary>;
  return typeof item.id === "string"
    && typeof item.kind === "string"
    && typeof item.name === "string"
    && "payload" in item
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string";
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
  saveXiaoqianApiKey: (apiKey: string) =>
    call<ProviderSecretStatus>("save_xiaoqian_api_key", { apiKey }, () => ({
      imageApiKeyStored: Boolean(apiKey.trim()),
      textApiKeyStored: Boolean(apiKey.trim()),
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
      watermarkPath: draft.watermarkPath,
      shopRole: draft.shopRole ?? "main",
      followsShopId: draft.followsShopId,
      followWarehouseId: draft.followWarehouseId,
      maintenanceWarehouseId: draft.maintenanceWarehouseId,
      maintenanceStock: draft.maintenanceStock ?? 50,
      maintenanceStockEnabled: draft.maintenanceStockEnabled ?? true,
      maintenanceBarcodeEnabled: draft.maintenanceBarcodeEnabled ?? true,
      maintenanceActionEnabled: draft.maintenanceActionEnabled ?? Boolean(draft.maintenanceActionConfigs?.length),
      maintenanceIntervalMinutes: draft.maintenanceIntervalMinutes ?? 5,
      maintenanceActionConfigs: draft.maintenanceActionConfigs ?? [],
      ozonSellerCookieStored: false,
      enabled: draft.enabled,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  deleteShop: (id: string) => call<void>("delete_shop", { id }, () => undefined),
  listTemplates: (kind: string) =>
    call<TemplateSummary[]>("list_templates", { kind }, () => listBrowserTemplates(kind), { fallbackWhenUnavailable: true }),
  saveTemplate: (draft: TemplateDraft) =>
    call<TemplateSummary>("save_template", { draft }, () => saveBrowserTemplate(draft), { fallbackWhenUnavailable: true }),
  deleteTemplate: (id: string) =>
    call<void>("delete_template", { id }, () => deleteBrowserTemplate(id), { fallbackWhenUnavailable: true }),
  testOzonConnection: (shopId: string) =>
    call<unknown>("test_ozon_connection", { shopId }, () => ({ result: { items: [] }, mock: true })),
  getShopUploadQuota: (shopId: string) =>
    call<OzonUploadQuota>("get_shop_upload_quota", { shopId }),
  testOssUpload: (shopId: string) =>
    call<string>("test_oss_upload", { shopId }, () => `https://example.com/healthcheck/${shopId}.txt`),
  getDeviceFingerprint: () =>
    call<string>("get_device_fingerprint", undefined, () => `browser-${window.navigator.userAgent}`),
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
  listProductAnalytics: (shopId: string, dateFrom: string, dateTo: string, limit?: number) =>
    call<ProductAnalyticsRow[]>(
      "list_product_analytics",
      { shopId, dateFrom, dateTo, limit: limit ?? 1000 },
      () => [
        {
          productId: 1001,
          offerId: "SKU001",
          name: "示例高浏览商品",
          categoryId: 17028924,
          categoryName: "发饰",
          typeId: 17028925,
          typeName: "束发带",
          searchViews: 120,
          cardViews: 80,
        },
      ],
    ),
  mergeProductCards: (shopId: string, productIds: number[]) =>
    call<unknown>(
      "merge_product_cards",
      { shopId, productIds },
      () => ({ selected: productIds.length, updated: productIds.length, groupCount: Math.ceil(productIds.length / 20) }),
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
  getProductDescription: (shopId: string, offerId: string) =>
    call<unknown>("get_product_description", { shopId, offerId }, () => ({ result: {} })),
  getProductStocks: (shopId: string, productIds: number[]) =>
    call<unknown>("get_product_stocks", { shopId, offerIds: [], productIds, visibility: "" }, () => ({ result: { items: [] } })),
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
  listActionCandidates: (shopId: string, actionId: number, limit?: number, lastId?: string) =>
    call<unknown>(
      "list_action_candidates",
      { shopId, actionId, limit: limit ?? 100, lastId: lastId ?? "" },
      () => ({ result: { products: [], total: 0 } }),
    ),
  activateActionProducts: (shopId: string, actionId: number, products: unknown[]) =>
    call<unknown>("activate_action_products", { shopId, actionId, products }, () => ({ result: products })),
  deactivateActionProducts: (shopId: string, actionId: number, productIds: number[]) =>
    call<unknown>("deactivate_action_products", { shopId, actionId, productIds }, () => ({ result: productIds })),
  deactivateAllActionProducts: (shopId: string, actionId: number) =>
    call<unknown>("deactivate_all_action_products", { shopId, actionId }, () => ({ total: 0, batches: 0, results: [] })),
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
  updateCategoryProducts: (request: UpdateCategoryProductsRequest) =>
    call<unknown>(
      "update_category_products",
      {
        shopId: request.shopId,
        categoryId: request.categoryId,
        typeId: request.typeId,
        cachedProducts: request.cachedProducts,
        warehouseId: request.warehouseId,
        stock: request.stock,
        price: request.price,
        oldPrice: request.oldPrice,
        currencyCode: request.currencyCode,
        updateStock: request.updateStock,
        updatePrice: request.updatePrice,
      },
      () => ({
        total: 1,
        stockUpdated: request.updateStock,
        priceUpdated: request.updatePrice,
        stockBatches: request.updateStock ? 1 : 0,
        priceBatches: request.updatePrice ? 1 : 0,
      }),
    ),
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
  startAutoListing: (request: AutoListingRequest) =>
    call<JobSummary>("start_auto_listing", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "auto_listing",
      title: "云图库自动上架",
      status: "running",
      progress: 5,
      inputPath: request.batchId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  schedulerStatus: (request: SchedulerStatusRequest) =>
    call<AutoListingSchedulerStatus>("scheduler_status", { request }),
  runAutoListingPlanNow: (request: RunAutoListingPlanNowRequest) =>
    call<AutoListingSchedulerStatus>("run_auto_listing_plan_now", { request }),
  pauseAutoListingPlan: (request: PauseAutoListingPlanRequest) =>
    call<AutoListingSchedulerStatus>("pause_auto_listing_plan", { request }),
  startLocalMockupRender: (request: LocalMockupRenderRequest) =>
    call<JobSummary>("start_local_mockup_render", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "local_mockup",
      title: "本地后台套图",
      status: "running",
      progress: 5,
      inputPath: request.templateId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  readLocalMockupResult: (resultPath: string) =>
    call<LocalMockupRenderResult>("read_local_mockup_result", { resultPath }),
  startListingImageRepair: (request: ListingImageRepairRequest) =>
    call<JobSummary>("start_listing_image_repair", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "listing_image_repair",
      title: "历史商品图片修复",
      status: "running",
      progress: 5,
      inputPath: `${request.items.length} items`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  startListedUpdate: (request: ListedUpdateRequest) =>
    call<JobSummary>("start_listed_update", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "listed_update",
      title: request.categoryUpdate ? "按类目更新已上架商品视频" : "按货号更新已上架商品",
      status: "running",
      progress: 5,
      inputPath: request.categoryUpdate ? request.categoryUpdate.categoryName || String(request.categoryUpdate.categoryId) : request.excelPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  reserveOrderShippingLabels: (assignments: OrderShippingLabelAssignment[]) =>
    call<void>("reserve_order_shipping_labels", { assignments }, () => undefined),
  downloadOrderShippingLabels: (request: OrderShippingLabelDownloadRequest) =>
    call<void>("download_order_shipping_labels", { request }, () => undefined),
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
  saveShopSellerCookie: (shopId: string, cookie: string) =>
    call<Shop>("save_shop_seller_cookie", { shopId, cookie }, () => ({
      id: shopId,
      name: "示例店铺",
      clientId: "mock-client",
      apiKeyStored: true,
      ossAccessKeyStored: false,
      ozonSellerCookieStored: Boolean(cookie.trim()),
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  listOrderPostings: (request: OrderListRequest) =>
    call<OrderPostingRow[]>("list_order_postings", { request }, () => [
      {
        shopId: request.shopId,
        shopName: "示例店铺",
        postingKind: "fbs",
        postingNumber: "12345678-0001-1",
        orderNumber: "12345678",
        orderId: 12345678,
        status: request.status || "awaiting_packaging",
        inProcessAt: `${request.dateFrom}T00:00:00Z`,
        shipmentDate: `${request.dateTo}T12:00:00Z`,
        warehouseName: "义乌仓库",
        trackingNumber: "12345678-0001-1",
        productsCount: 1,
        offerIds: ["SKU001"],
        products: [
          {
            productId: 1001,
            offerId: "SKU001",
            name: "示例丝巾商品",
            quantity: 1,
            price: 1999,
            currencyCode: "RUB",
            imageUrl: "https://placehold.co/96x96/png?text=SKU001",
          },
        ],
        imageUrl: "https://placehold.co/96x96/png?text=SKU001",
        salesAmount: 1999,
        currencyCode: "RUB",
        syncedAt: new Date().toISOString(),
      },
    ]),
  listSavedOrderPostings: (query: StoredOrderQuery = {}) =>
    call<OrderPostingRow[]>("list_saved_order_postings", { query }, () => [
      {
        shopId: query.shopIds?.[0] || "mock-shop",
        shopName: "示例店铺",
        postingKind: "fbs",
        postingNumber: "47202470-0140-1",
        orderNumber: "47202470",
        orderId: 47202470,
        status: query.status || "delivering",
        inProcessAt: new Date().toISOString(),
        shipmentDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        warehouseName: "义乌仓库",
        trackingNumber: "47202470-0140-1",
        productsCount: 1,
        offerIds: ["TM20251110001297"],
        products: [
          {
            productId: 1002,
            offerId: "TM20251110001297",
            name: "示例头巾商品",
            quantity: 1,
            price: 2200,
            currencyCode: "RUB",
            imageUrl: "https://placehold.co/96x96/png?text=TM2025",
          },
        ],
        imageUrl: "https://placehold.co/96x96/png?text=TM2025",
        salesAmount: 2200,
        currencyCode: "RUB",
        syncedAt: new Date().toISOString(),
      },
    ]),
  shipOrderPosting: (shopId: string, postingNumber: string) =>
    call<OrderPostingRow>(
      "ship_order_posting",
      { shopId, postingNumber },
      () => ({
        shopId,
        shopName: "示例店铺",
        postingKind: "fbs",
        postingNumber,
        orderNumber: postingNumber.split("-")[0],
        status: "awaiting_deliver",
        inProcessAt: new Date().toISOString(),
        shipmentDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        warehouseName: "义乌仓库",
        trackingNumber: postingNumber,
        productsCount: 1,
        offerIds: ["SKU001"],
        products: [
          {
            productId: 1001,
            offerId: "SKU001",
            name: "示例丝巾商品",
            quantity: 1,
            price: 1999,
            currencyCode: "RUB",
            imageUrl: "https://placehold.co/96x96/png?text=SKU001",
          },
        ],
        imageUrl: "https://placehold.co/96x96/png?text=SKU001",
        salesAmount: 1999,
        currencyCode: "RUB",
        syncedAt: new Date().toISOString(),
      }),
    ),
  startFollowSync: (shopId: string, priceMultiplier: number) =>
    call<JobSummary>("start_follow_sync", { shopId, priceMultiplier }, () => ({
      id: crypto.randomUUID(),
      kind: "follow_sync",
      title: "跟卖商品同步",
      status: "running",
      progress: 5,
      inputPath: shopId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  startFollowAutomation: (request: FollowAutomationRequest) =>
    call<JobSummary>("start_follow_automation", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "follow_automation",
      title: "跟卖自动化",
      status: "running",
      progress: 5,
      inputPath: request.shopId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  startListingMaintenance: (request: ListingMaintenanceRequest) =>
    call<JobSummary>("start_listing_maintenance", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "listing_maintenance",
      title: "店铺自动运维",
      status: "running",
      progress: 5,
      inputPath: request.shopId,
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
  scanGalleryUploadFiles: (paths: string[]) =>
    call<GalleryUploadSelection>(
      "scan_gallery_upload_files",
      { paths },
      () => ({ count: 0, totalBytes: 0, sampleNames: [], paths: [] }),
    ),
  startGalleryUploadJob: (request: GalleryUploadRequest) =>
    call<JobSummary>("start_gallery_upload_job", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "gallery_upload",
      title: "云图库图片上传",
      status: "running",
      progress: 5,
      inputPath: request.sourceLabel,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  preflightMaterials: (request: MaterialsRequest) =>
    call<PreflightIssue[]>("preflight_materials", { request }, () => [
      { level: "info", scope: "预检查", message: "浏览器预览模式：桌面端会检查目录、云端 AI 授权和预计处理量。" },
    ]),
  listAiModels: (baseUrl: string, provider: string, kind?: "image" | "text") =>
    call<string[]>(
      "list_ai_models",
      {
        baseUrl,
        provider,
        kind,
        cloudAuthToken: getCloudToken() || undefined,
      },
      () => [kind === "image" ? defaultSettings.imageModel : defaultSettings.textModel],
    ),
  renameMaterialImages: (request: ImageRenameRequest) =>
    call<ImageRenameResult>("rename_material_images", { request }, () => ({
      count: 0,
      outputRoot: request.outputRoot,
    })),
  preflightBatchUpload: (request: BatchUploadRequest) =>
    call<PreflightIssue[]>("preflight_batch_upload", { request }, () => [
      { level: "info", scope: "预检查", message: "浏览器预览模式：桌面端会检查店铺、OSS、Excel 和 SKU 图片匹配。" },
    ]),
  preflightListedUpdate: (request: ListedUpdateRequest) =>
    call<PreflightIssue[]>("preflight_listed_update", { request }, () => [
      {
        level: "info",
        scope: "预检查",
        message: request.categoryUpdate
          ? "浏览器预览模式：桌面端会检查店铺、类目、视频链接和线上商品连接。"
          : "浏览器预览模式：桌面端会检查店铺、Excel、更新项和线上商品连接；只有更新图片时才检查图片目录。",
      },
    ]),
  startLocalSceneJob: (request: LocalSceneRequest) =>
    call<JobSummary>("start_local_scene_job", { request }, () => ({
      id: crypto.randomUUID(),
      kind: "scene_local",
      title: "本地场景图合成",
      status: "running",
      progress: 5,
      inputPath: request.singleImage || request.sourceRoot,
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
  pickDirectory: () => call<string>("pick_directory"),
  pickFile: () => call<string>("pick_file"),
  pickImageFiles: () => call<string[]>("pick_image_files"),
};
