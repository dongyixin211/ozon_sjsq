import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from 'react';
import type { AppSettings, CategoryOption, FollowAutomationRequest, JobSummary, ListingMaintenanceActionConfig, ListingMaintenanceRequest, OrderPostingRow, OzonProductRow, PreflightIssue, ProductAnalyticsRow, Shop, ShopDraft, TemplateSummary, WarehouseOption } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";
import { LongOutput } from "../../lib/LongOutput";
import { hasBlockingIssues, PreflightPanel } from "../../lib/PreflightPanel";
import { buildActionProductPayload, extractNextLastId } from "./actionUtils";
import { selectInventoryProducts } from "./inventoryUtils";
import { hasBaiduBdussCookie, parseOrderNumbers, selectedPostingNumbersInRowOrder } from "./orderUtils";

interface Props {
  shops: Shop[];
  jobs?: JobSummary[];
  settings: AppSettings;
  homeRequest?: number;
  onChanged: () => void;
  onNavigate: (page: "ozon" | "jobs") => void;
  onHeaderChange?: (content: ReactNode | null) => void;
}

type TabKey = "upload" | "update" | "orders" | "follow" | "inventory" | "analytics" | "api";
type InventoryMode = "products" | "actions";
type CategoryUpdateMode = "stock" | "price" | "both";
type OperationFeedback = { tone: "success" | "error" | "running"; message: string };
const PRODUCT_TEMPLATE_KIND = "product_import";
const LISTING_MAINTENANCE_INTERVAL_MINUTES = 120;
const TASK_TABS: Array<{ key: TabKey; label: string; description: string; primaryAction: string }> = [
  { key: "upload", label: "上架商品", description: "用 Excel、图片目录和商品模板创建 Ozon 上架任务。", primaryAction: "去上架" },
  { key: "update", label: "更新商品", description: "按货号更新已上架商品的标题、图片、视频和富内容。", primaryAction: "去更新" },
  { key: "orders", label: "下载订单文件", description: "按订单或货件编号下载标签、条码、拣货单和货号素材。", primaryAction: "去下载" },
  { key: "follow", label: "跟卖同步", description: "把主店商品补齐到跟卖店铺，并按 3 倍售价上架。", primaryAction: "去同步" },
  { key: "inventory", label: "库存价格活动", description: "查询商品后批量补库存、改价、生成条码或申报活动。", primaryAction: "去运维" },
  { key: "analytics", label: "浏览量与合并", description: "查看商品浏览量，并将同类目商品每 20 个合并为一张商品卡。", primaryAction: "去分析" },
  { key: "api", label: "接口诊断", description: "检查 Ozon 连接和接口原始结果。", primaryAction: "去诊断" },
];

interface ActionRow {
  id: number;
  title: string;
  dateStart?: string;
  dateEnd?: string;
  status?: string;
}

interface ActionProductRow {
  productId?: number;
  offerId: string;
  name: string;
  primaryImage?: string;
  productUrl?: string;
  price?: string;
  currencyCode?: string;
  actionPrice?: string;
  stock?: number;
  discount?: number;
  maxActionPrice?: string;
  minActionPrice?: string;
  status?: string;
  raw: Record<string, unknown>;
}

interface CacheEntry<T> {
  savedAt: string;
  data: T;
}

interface OrderDocumentsDraft {
  shopId?: string;
  orderNumbersText?: string;
  orderOutputRoot?: string;
  ozonSellerHarPath?: string;
  ozonSellerCookiePath?: string;
  baiduSearchDir?: string;
  baiduRecursive?: boolean;
  downloadMaterials?: boolean;
  orderDateFrom?: string;
  orderDateTo?: string;
  orderStatus?: string;
  orderLimit?: number;
}

interface ListedUpdateDraft {
  shopId?: string;
  tab?: TabKey;
  portraitRoot?: string;
  excelPath?: string;
  maxItems?: number;
  templateVideoLinks?: string;
  updateTitle?: boolean;
  updateDescription?: boolean;
  updateImages?: boolean;
  updateVideo?: boolean;
  updateRichJson?: boolean;
  selectedTemplateId?: string;
  templateName?: string;
  templateOfferId?: string;
  selectedWarehouseId?: number | "";
  inventoryMode?: InventoryMode;
  selectedCategoryId?: number | "";
  categoryVideoShopIds?: string[];
  categoryKeyword?: string;
  categoryLimit?: number;
  newPrice?: string;
  newOldPrice?: string;
  currencyCode?: string;
  maintenanceActionCategoryId?: number | "";
  maintenanceActionId?: number | "";
  maintenanceActionPrice?: string;
  maintenanceActionStock?: number;
  analyticsDateFrom?: string;
  analyticsDateTo?: string;
  analyticsLimit?: number;
  minimumCardViews?: number;
}

interface ListedCategoryUpdateTarget {
  categoryId: number;
  typeId?: number;
  categoryName?: string;
  cachedProducts?: Array<Pick<OzonProductRow, "offerId" | "name">>;
}

interface FollowAutomationDraft {
  autoFollowSync?: boolean;
  autoUpdateStock?: boolean;
  autoGenerateBarcode?: boolean;
  autoAddToAction?: boolean;
  intervalMinutes?: number;
  maxFollowItems?: number;
  priceMultiplier?: number;
  stockValue?: number;
  selectedWarehouseId?: number | "";
  selectedActionId?: number | "";
  actionPrice?: string;
  actionStock?: number;
  inventoryMode?: InventoryMode;
  actionProductLimit?: number;
}

const QUERY_CACHE_PREFIX = "ozon-sjsq:query-cache:v1";
const QUERY_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const ORDER_DOCUMENTS_DRAFT_KEY = "ozon-sjsq:order-documents-draft:v1";
const LISTED_UPDATE_DRAFT_KEY = "ozon-sjsq:listed-update-draft:v1";
const FOLLOW_AUTOMATION_DRAFT_KEY = "ozon-sjsq:follow-automation-draft:v1";
const PRODUCT_TEMPLATE_SELECTION_KEY = "ozon-sjsq:product-template-selection:v1";

function queryCacheKey(shopId: string, name: string) {
  return `${QUERY_CACHE_PREFIX}:${shopId}:${name}`;
}

function readQueryCache<T>(shopId: string, name: string): CacheEntry<T> | undefined {
  if (!shopId || typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(queryCacheKey(shopId, name));
    return raw ? JSON.parse(raw) as CacheEntry<T> : undefined;
  } catch {
    return undefined;
  }
}

function writeQueryCache<T>(shopId: string, name: string, data: T) {
  if (!shopId || typeof window === "undefined") return;
  const key = queryCacheKey(shopId, name);
  const payload = JSON.stringify({
    savedAt: new Date().toISOString(),
    data,
  });
  if (storagePayloadSize(payload) > QUERY_CACHE_MAX_BYTES) {
    removeStorageItem(key);
    return;
  }
  try {
    window.localStorage.setItem(key, payload);
    return;
  } catch (error) {
    if (!isStorageQuotaError(error)) return;
  }
  clearQueryCaches();
  try {
    window.localStorage.setItem(key, payload);
  } catch {
    removeStorageItem(key);
    // 查询缓存只是页面加速项，写不进去时不能影响当前业务操作。
  }
}

function isStorageQuotaError(error: unknown) {
  return error instanceof DOMException
    && (error.name === "QuotaExceededError"
      || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
      || error.code === 22
      || error.code === 1014);
}

function clearQueryCaches() {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(QUERY_CACHE_PREFIX)) {
      window.localStorage.removeItem(key);
    }
  }
}

function removeStorageItem(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function storagePayloadSize(payload: string) {
  return typeof TextEncoder === "undefined"
    ? payload.length
    : new TextEncoder().encode(payload).length;
}

function normalizeShopIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function readOrderDocumentsDraft(): OrderDocumentsDraft {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ORDER_DOCUMENTS_DRAFT_KEY);
    return raw ? JSON.parse(raw) as OrderDocumentsDraft : {};
  } catch {
    return {};
  }
}

function writeOrderDocumentsDraft(draft: OrderDocumentsDraft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ORDER_DOCUMENTS_DRAFT_KEY, JSON.stringify(draft));
}

function readListedUpdateDraft(): ListedUpdateDraft {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LISTED_UPDATE_DRAFT_KEY);
    return raw ? JSON.parse(raw) as ListedUpdateDraft : {};
  } catch {
    return {};
  }
}

function writeListedUpdateDraft(draft: ListedUpdateDraft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LISTED_UPDATE_DRAFT_KEY, JSON.stringify(draft));
}

function readFollowAutomationDraft(): FollowAutomationDraft {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FOLLOW_AUTOMATION_DRAFT_KEY);
    return raw ? JSON.parse(raw) as FollowAutomationDraft : {};
  } catch {
    return {};
  }
}

function writeFollowAutomationDraft(draft: FollowAutomationDraft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FOLLOW_AUTOMATION_DRAFT_KEY, JSON.stringify(draft));
}

function readSelectedProductTemplateId() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(PRODUCT_TEMPLATE_SELECTION_KEY) ?? "";
}

function writeSelectedProductTemplateId(id: string) {
  if (typeof window === "undefined") return;
  if (id) {
    window.localStorage.setItem(PRODUCT_TEMPLATE_SELECTION_KEY, id);
  } else {
    window.localStorage.removeItem(PRODUCT_TEMPLATE_SELECTION_KEY);
  }
}

function dateInputValue(daysAgo: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function restoreShopId(savedId: string | undefined, shops: Shop[]) {
  if (savedId && shops.some((shop) => shop.id === savedId)) {
    return savedId;
  }
  return shops.find((shop) => shop.enabled)?.id ?? shops[0]?.id ?? "";
}

function isListingMaintenanceEnabledForShop(shop: Shop) {
  return (shop.maintenanceStockEnabled ?? true)
    || (shop.maintenanceBarcodeEnabled ?? true)
    || ((shop.maintenanceActionEnabled ?? true) && (shop.maintenanceActionConfigs ?? []).length > 0);
}

function restorePositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function restoreNonNegativeInt(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function OzonPage({ shops, jobs = [], settings, homeRequest = 0, onChanged, onNavigate, onHeaderChange }: Props) {
  const savedOrderDraft = readOrderDocumentsDraft();
  const savedUpdateDraft = readListedUpdateDraft();
  const savedFollowDraft = readFollowAutomationDraft();
  const [tab, setTab] = useState<TabKey>(normalizeSavedTab(savedUpdateDraft.tab));
  const [shopId, setShopId] = useState<string>(() => restoreShopId(savedUpdateDraft.shopId ?? savedOrderDraft.shopId, shops));
  const [shopCenterOpen, setShopCenterOpen] = useState(false);
  const [shopDialogOpen, setShopDialogOpen] = useState(false);
  const [editingShop, setEditingShop] = useState<Shop | undefined>(undefined);
  const [shopMessage, setShopMessage] = useState("");
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [warehousesLoading, setWarehousesLoading] = useState(false);
  const [warehouseError, setWarehouseError] = useState("");
  const [result, setResult] = useState("");
  const [friendlyMessage, setFriendlyMessage] = useState("");
  const [friendlyTone, setFriendlyTone] = useState<"info" | "error">("info");
  const [inventoryFeedback, setInventoryFeedback] = useState<OperationFeedback | null>(null);
  const [issues, setIssues] = useState<PreflightIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const [portraitRoot, setPortraitRoot] = useState(savedUpdateDraft.portraitRoot ?? settings.defaultOutputRoot);
  const [excelPath, setExcelPath] = useState(savedUpdateDraft.excelPath ?? settings.uploadExcelPath);
  const [maxItems, setMaxItems] = useState(restorePositiveInt(savedUpdateDraft.maxItems, settings.uploadMaxItems || 100));
  const [templateVideoLinks, setTemplateVideoLinks] = useState(savedUpdateDraft.templateVideoLinks ?? "");
  const [updateTitle, setUpdateTitle] = useState(savedUpdateDraft.updateTitle ?? true);
  const [updateDescription, setUpdateDescription] = useState(savedUpdateDraft.updateDescription ?? true);
  const [updateImages, setUpdateImages] = useState(savedUpdateDraft.updateImages ?? true);
  const [updateVideo, setUpdateVideo] = useState(savedUpdateDraft.updateVideo ?? false);
  const [updateRichJson, setUpdateRichJson] = useState(savedUpdateDraft.updateRichJson ?? false);
  const [orderNumbersText, setOrderNumbersText] = useState(savedOrderDraft.orderNumbersText ?? "");
  const [orderShippingLabelText, setOrderShippingLabelText] = useState("");
  const [orderOutputRoot, setOrderOutputRoot] = useState(savedOrderDraft.orderOutputRoot ?? settings.defaultOutputRoot);
  const [ozonSellerHarPath, setOzonSellerHarPath] = useState(savedOrderDraft.ozonSellerHarPath ?? "");
  const [ozonSellerCookiePath, setOzonSellerCookiePath] = useState(savedOrderDraft.ozonSellerCookiePath ?? "");
  const [baiduCookie, setBaiduCookie] = useState(settings.baiduCookie);
  const [baiduSearchDir, setBaiduSearchDir] = useState(savedOrderDraft.baiduSearchDir ?? "/");
  const [baiduRecursive, setBaiduRecursive] = useState(savedOrderDraft.baiduRecursive ?? true);
  const [downloadMaterials, setDownloadMaterials] = useState(savedOrderDraft.downloadMaterials ?? false);
  const [orderDateFrom, setOrderDateFrom] = useState(savedOrderDraft.orderDateFrom || dateInputValue(7));
  const [orderDateTo, setOrderDateTo] = useState(savedOrderDraft.orderDateTo || dateInputValue(0));
  const [orderStatus, setOrderStatus] = useState(savedOrderDraft.orderStatus || "");
  const [orderLimit, setOrderLimit] = useState(restorePositiveInt(savedOrderDraft.orderLimit, 100));
  const [orderRows, setOrderRows] = useState<OrderPostingRow[]>([]);
  const [selectedPostingNumbers, setSelectedPostingNumbers] = useState<string[]>([]);
  const latestOrderPostingsRequestRef = useRef(0);
  const [products, setProducts] = useState<OzonProductRow[]>([]);
  const [inventoryMode, setInventoryMode] = useState<InventoryMode>(savedFollowDraft.inventoryMode ?? savedUpdateDraft.inventoryMode ?? "products");
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  const [productPage, setProductPage] = useState(1);
  const [productPageSize, setProductPageSize] = useState(10);
  const [stockValue, setStockValue] = useState(savedFollowDraft.stockValue ?? 10);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<number | "">(savedFollowDraft.selectedWarehouseId ?? savedUpdateDraft.selectedWarehouseId ?? "");
  const [maintenanceStock, setMaintenanceStock] = useState(50);
  const [maintenanceWarehouseId, setMaintenanceWarehouseId] = useState<number | "">("");
  const [maintenanceAutoStock, setMaintenanceAutoStock] = useState(true);
  const [maintenanceAutoBarcode, setMaintenanceAutoBarcode] = useState(true);
  const [maintenanceAutoAction, setMaintenanceAutoAction] = useState(true);
  const [maintenanceActionConfigs, setMaintenanceActionConfigs] = useState<ListingMaintenanceActionConfig[]>([]);
  const [maintenanceIntervalMinutes, setMaintenanceIntervalMinutes] = useState(LISTING_MAINTENANCE_INTERVAL_MINUTES);
  const [maintenanceActionCategoryId, setMaintenanceActionCategoryId] = useState<number | "">(savedUpdateDraft.maintenanceActionCategoryId ?? "");
  const [maintenanceActionId, setMaintenanceActionId] = useState<number | "">(savedUpdateDraft.maintenanceActionId ?? "");
  const [maintenanceActionPrice, setMaintenanceActionPrice] = useState(savedUpdateDraft.maintenanceActionPrice ?? "");
  const [maintenanceActionStock, setMaintenanceActionStock] = useState(savedUpdateDraft.maintenanceActionStock ?? 50);
  const [maintenanceCategorySearch, setMaintenanceCategorySearch] = useState("");
  const autoLoadedShopDataRef = useRef(new Set<string>());
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | "">(savedUpdateDraft.selectedCategoryId ?? "");
  const [categoryVideoShopIds, setCategoryVideoShopIds] = useState<string[]>(
    normalizeShopIds(savedUpdateDraft.categoryVideoShopIds ?? []).filter((id) => shops.some((shop) => shop.id === id)),
  );
  const [categoryKeyword, setCategoryKeyword] = useState(savedUpdateDraft.categoryKeyword ?? "");
  const [categoryLimit, setCategoryLimit] = useState(restorePositiveInt(savedUpdateDraft.categoryLimit, 100));
  const [newPrice, setNewPrice] = useState(savedUpdateDraft.newPrice ?? "");
  const [newOldPrice, setNewOldPrice] = useState(savedUpdateDraft.newOldPrice ?? "");
  const [currencyCode, setCurrencyCode] = useState(savedUpdateDraft.currencyCode ?? "");
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(savedUpdateDraft.selectedTemplateId ?? "");
  const [templateName, setTemplateName] = useState(savedUpdateDraft.templateName ?? "");
  const [templateOfferId, setTemplateOfferId] = useState(savedUpdateDraft.templateOfferId ?? "");
  const [templateJson, setTemplateJson] = useState("");
  const [templateProduct, setTemplateProduct] = useState<unknown | undefined>(undefined);
  const [templateStatus, setTemplateStatus] = useState("未选择商品模板");
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [selectedActionId, setSelectedActionId] = useState<number | "">(savedFollowDraft.selectedActionId ?? "");
  const [pendingDeleteAllActionId, setPendingDeleteAllActionId] = useState<number | "">("");
  const [actionProducts, setActionProducts] = useState<ActionProductRow[]>([]);
  const [actionCandidates, setActionCandidates] = useState<ActionProductRow[]>([]);
  const [selectedActionProductIds, setSelectedActionProductIds] = useState<number[]>([]);
  const [selectedActionCandidateIds, setSelectedActionCandidateIds] = useState<number[]>([]);
  const [actionProductLimit, setActionProductLimit] = useState(restorePositiveInt(savedFollowDraft.actionProductLimit, 100));
  const [actionProductLastId, setActionProductLastId] = useState("");
  const [nextActionProductLastId, setNextActionProductLastId] = useState("");
  const [actionCandidateLastId, setActionCandidateLastId] = useState("");
  const [nextActionCandidateLastId, setNextActionCandidateLastId] = useState("");
  const [actionPrice, setActionPrice] = useState(savedFollowDraft.actionPrice ?? "");
  const [actionStock, setActionStock] = useState(savedFollowDraft.actionStock ?? 10);
  const [autoPostProcess, setAutoPostProcess] = useState(false);
  const [followAutoSync, setFollowAutoSync] = useState(savedFollowDraft.autoFollowSync ?? true);
  const [followAutoStock, setFollowAutoStock] = useState(savedFollowDraft.autoUpdateStock ?? true);
  const [followAutoBarcode, setFollowAutoBarcode] = useState(savedFollowDraft.autoGenerateBarcode ?? true);
  const [followAutoAction, setFollowAutoAction] = useState(savedFollowDraft.autoAddToAction ?? false);
  const [followIntervalMinutes, setFollowIntervalMinutes] = useState(savedFollowDraft.intervalMinutes ?? 60);
  const [followMaxItems, setFollowMaxItems] = useState(savedFollowDraft.maxFollowItems ?? settings.uploadMaxItems);
  const [followPriceMultiplier, setFollowPriceMultiplier] = useState(savedFollowDraft.priceMultiplier ?? 3);
  const [analyticsDateFrom, setAnalyticsDateFrom] = useState(savedUpdateDraft.analyticsDateFrom ?? dateInputValue(29));
  const [analyticsDateTo, setAnalyticsDateTo] = useState(savedUpdateDraft.analyticsDateTo ?? dateInputValue(0));
  const [analyticsLimit, setAnalyticsLimit] = useState(restorePositiveInt(savedUpdateDraft.analyticsLimit, 1000));
  const [minimumCardViews, setMinimumCardViews] = useState(restoreNonNegativeInt(savedUpdateDraft.minimumCardViews, 1));
  const [analyticsRows, setAnalyticsRows] = useState<ProductAnalyticsRow[]>([]);
  const [selectedAnalyticsProductIds, setSelectedAnalyticsProductIds] = useState<number[]>([]);
  const [mergeConfirmPending, setMergeConfirmPending] = useState(false);

  const uploadRequest = () => ({
    cloudApiBaseUrl: settings.cloudApiBaseUrl,
    shopIds: shopId ? [shopId] : [],
    portraitRoot,
    excelPath,
    templateProduct,
    maxItems: maxItems || undefined,
    uploadTemplateVideo: templateVideoLinks.trim().length > 0,
    templateVideoLinks: templateVideoLinks ? templateVideoLinks.split("\n").map((item) => item.trim()).filter(Boolean) : [],
    autoGenerateBarcode: autoPostProcess,
    autoUpdateStock: autoPostProcess,
    autoAddToAction: autoPostProcess,
    autoWarehouseId: typeof selectedWarehouseId === "number" ? selectedWarehouseId : undefined,
    autoStock: stockValue,
    autoActionId: typeof selectedActionId === "number" ? selectedActionId : undefined,
    autoActionPrice: actionPrice.trim() || undefined,
    autoActionStock: actionStock,
  });

  const followAutomationRequest = (): FollowAutomationRequest => ({
    shopId,
    intervalMinutes: followIntervalMinutes || 60,
    maxFollowItems: followMaxItems > 0 ? followMaxItems : undefined,
    priceMultiplier: followPriceMultiplier,
    autoFollowSync: followAutoSync,
    autoUpdateStock: followAutoStock,
    autoGenerateBarcode: followAutoBarcode,
    autoAddToAction: followAutoAction,
    stock: stockValue,
    actionId: typeof selectedActionId === "number" ? selectedActionId : undefined,
    actionPrice: actionPrice.trim() || undefined,
    actionStock,
  });

  const listingMaintenanceRequest = (): ListingMaintenanceRequest => {
    const actionReady = maintenanceAutoAction && maintenanceActionConfigs.length > 0;
    return {
      shopId,
    intervalMinutes: LISTING_MAINTENANCE_INTERVAL_MINUTES,
      autoUpdateStock: maintenanceAutoStock,
      autoGenerateBarcode: maintenanceAutoBarcode,
      autoAddToAction: actionReady,
      warehouseId: typeof maintenanceWarehouseId === "number" ? maintenanceWarehouseId : undefined,
      stock: maintenanceStock,
      actionConfigs: actionReady ? maintenanceActionConfigs : [],
    };
  };

  const listingMaintenanceRequestForShop = (shop: Shop): ListingMaintenanceRequest => {
    const actionConfigs = shop.maintenanceActionConfigs ?? [];
    const actionReady = (shop.maintenanceActionEnabled ?? true) && actionConfigs.length > 0;
    return {
      shopId: shop.id,
      intervalMinutes: LISTING_MAINTENANCE_INTERVAL_MINUTES,
      autoUpdateStock: shop.maintenanceStockEnabled ?? true,
      autoGenerateBarcode: shop.maintenanceBarcodeEnabled ?? true,
      autoAddToAction: actionReady,
      warehouseId: shop.maintenanceWarehouseId,
      stock: shop.maintenanceStock ?? 50,
      actionConfigs: actionReady ? actionConfigs : [],
    };
  };

  const updateRequest = (categoryUpdate?: ListedCategoryUpdateTarget) => ({
    shopId,
    portraitRoot,
    excelPath,
    maxItems: maxItems || undefined,
    updateTitle,
    updateDescription,
    updateImages,
    updateVideo,
    updateRichJson,
    templateProduct,
    templateVideoLinks: templateVideoLinks ? templateVideoLinks.split("\n").map((item) => item.trim()).filter(Boolean) : [],
    categoryUpdate,
  });

  const orderDocumentsRequest = (orderNumbers = parseOrderNumbers(orderNumbersText)) => {
    const urls = orderShippingLabelText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return {
      shopId,
      orderNumbers,
      outputRoot: orderOutputRoot,
      ozonCompanyId: currentShop?.clientId,
      ozonSellerHarPath,
      ozonSellerCookiePath,
      baiduCookie,
      baiduSearchDir,
      baiduRecursive,
      downloadMaterials,
      shippingLabels: orderNumbers.map((orderNumber, index) => ({ orderNumber, url: urls[index] ?? "" })),
    };
  };

  const currentShop = shops.find((shop) => shop.id === shopId);
  const runningListingMaintenanceJobs = useMemo(
    () => jobs.filter((job) => (
      job.kind === "listing_maintenance"
      && (job.status === "running" || job.status === "queued")
      && Boolean(job.inputPath)
    )),
    [jobs],
  );
  const runningListingMaintenanceJob = useMemo(
    () => runningListingMaintenanceJobs.find((job) => job.inputPath === shopId),
    [runningListingMaintenanceJobs, shopId],
  );
  const maintenanceEnabled = maintenanceAutoStock || maintenanceAutoBarcode || (maintenanceAutoAction && maintenanceActionConfigs.length > 0);
  const enabledShops = useMemo(() => shops.filter((shop) => shop.enabled), [shops]);
  const followerShops = shops.filter((shop) => (shop.shopRole ?? "main") === "follower" && shop.followsShopId === shopId);
  const currentMainShop = currentShop?.followsShopId ? shops.find((shop) => shop.id === currentShop.followsShopId) : undefined;
  const analyticsMaxDate = dateInputValue(0);
  const visibleAnalyticsRows = analyticsRows.filter((row) => row.cardViews >= minimumCardViews);

  useEffect(() => {
    if (shops.length === 0) return;
    if (!shopId || !shops.some((shop) => shop.id === shopId)) {
      setShopId(restoreShopId(savedUpdateDraft.shopId ?? savedOrderDraft.shopId, shops));
    }
  }, [shopId, shops, savedUpdateDraft.shopId, savedOrderDraft.shopId]);

  useEffect(() => {
    const validShopIds = new Set(shops.map((shop) => shop.id));
    setCategoryVideoShopIds((current) => current.filter((id) => validShopIds.has(id)));
  }, [shops]);

  useEffect(() => {
    setMaintenanceWarehouseId(currentShop?.maintenanceWarehouseId ?? "");
    setMaintenanceStock(currentShop?.maintenanceStock ?? 50);
    setMaintenanceAutoStock(currentShop?.maintenanceStockEnabled ?? true);
    setMaintenanceAutoBarcode(currentShop?.maintenanceBarcodeEnabled ?? true);
    const actionConfigs = currentShop?.maintenanceActionConfigs ?? [];
    setMaintenanceActionConfigs(actionConfigs);
    setMaintenanceAutoAction((currentShop?.maintenanceActionEnabled ?? true) || actionConfigs.length > 0);
    setMaintenanceIntervalMinutes(LISTING_MAINTENANCE_INTERVAL_MINUTES);
  }, [currentShop?.id, currentShop?.updatedAt]);

  useEffect(() => {
    if (homeRequest === 0) return;
    setShopCenterOpen(false);
    setShopDialogOpen(false);
    setEditingShop(undefined);
    setTab("upload");
    window.requestAnimationFrame(() => {
      document.querySelector(".main")?.scrollTo({ top: 0, behavior: "smooth" });
    });
  }, [homeRequest]);

  useEffect(() => {
    writeOrderDocumentsDraft({
      shopId,
      orderNumbersText,
      orderOutputRoot,
      ozonSellerHarPath,
      ozonSellerCookiePath,
      baiduSearchDir,
      baiduRecursive,
      downloadMaterials,
      orderDateFrom,
      orderDateTo,
      orderStatus,
      orderLimit,
    });
  }, [
    shopId,
    orderNumbersText,
    orderOutputRoot,
    ozonSellerHarPath,
    ozonSellerCookiePath,
    baiduSearchDir,
    baiduRecursive,
    downloadMaterials,
    orderDateFrom,
    orderDateTo,
    orderStatus,
    orderLimit,
  ]);

  useEffect(() => {
    writeListedUpdateDraft({
      shopId,
      tab,
      portraitRoot,
      excelPath,
      maxItems,
      templateVideoLinks,
      updateTitle,
      updateDescription,
      updateImages,
      updateVideo,
      updateRichJson,
      selectedTemplateId,
      templateName,
      templateOfferId,
      selectedWarehouseId,
      inventoryMode,
      selectedCategoryId,
      categoryVideoShopIds,
      categoryKeyword,
      categoryLimit,
      newPrice,
      newOldPrice,
      currencyCode,
      maintenanceActionCategoryId,
      maintenanceActionId,
      maintenanceActionPrice,
      maintenanceActionStock,
      analyticsDateFrom,
      analyticsDateTo,
      analyticsLimit,
      minimumCardViews,
    });
  }, [
    shopId,
    tab,
    portraitRoot,
    excelPath,
    maxItems,
    templateVideoLinks,
    updateTitle,
    updateDescription,
    updateImages,
    updateVideo,
    updateRichJson,
    selectedTemplateId,
    templateName,
    templateOfferId,
    selectedWarehouseId,
    inventoryMode,
    selectedCategoryId,
    categoryVideoShopIds,
    categoryKeyword,
    categoryLimit,
    newPrice,
    newOldPrice,
    currencyCode,
    maintenanceActionCategoryId,
    maintenanceActionId,
    maintenanceActionPrice,
    maintenanceActionStock,
    analyticsDateFrom,
    analyticsDateTo,
    analyticsLimit,
    minimumCardViews,
  ]);

  useEffect(() => {
    writeFollowAutomationDraft({
      autoFollowSync: followAutoSync,
      autoUpdateStock: followAutoStock,
      autoGenerateBarcode: followAutoBarcode,
      autoAddToAction: followAutoAction,
      intervalMinutes: followIntervalMinutes,
      maxFollowItems: followMaxItems,
      priceMultiplier: followPriceMultiplier,
      stockValue,
      selectedWarehouseId,
      selectedActionId,
      actionPrice,
      actionStock,
      inventoryMode,
      actionProductLimit,
    });
  }, [
    followAutoSync,
    followAutoStock,
    followAutoBarcode,
    followAutoAction,
    followIntervalMinutes,
    followMaxItems,
    followPriceMultiplier,
    stockValue,
    selectedWarehouseId,
    selectedActionId,
    actionPrice,
    actionStock,
    inventoryMode,
    actionProductLimit,
  ]);

  const loadWarehouses = async (id: string) => {
    if (!id) {
      setWarehouses([]);
      setWarehouseError("请先在店铺管理里保存店铺，并选择店铺后获取仓库。");
      return;
    }
    setWarehousesLoading(true);
    setWarehouseError("");
    try {
      const data = await api.listWarehouses(id);
      setWarehouses(data);
      writeQueryCache(id, "warehouses", data);
      setSelectedWarehouseId((current) => current || data[0]?.warehouseId || "");
      if (data.length === 0) {
        setWarehouseError("接口已连接，但 Ozon 没有返回仓库数据。请确认该店铺已开通仓库。");
      }
    } catch (error) {
      const message = String(error);
      setWarehouses([]);
      setWarehouseError(message);
      setResult(message);
    } finally {
      setWarehousesLoading(false);
    }
  };

  const run = async (action: () => Promise<void>) => {
    setResult("");
    setFriendlyMessage("");
    setFriendlyTone("info");
    try {
      await action();
    } catch (error) {
      const message = friendlyError(error);
      setFriendlyTone("error");
      setFriendlyMessage(message);
      setResult(message);
    }
  };

  const setProductRows = (rows: OzonProductRow[]) => {
    setProducts(rows);
    setSelectedProductIds([]);
    setProductPage(1);
  };

  const cacheProductRows = (rows: OzonProductRow[], source: string) => {
    setProductRows(rows);
    writeQueryCache(shopId, "inventory-products", { source, rows });
  };

  const categoryProductCacheName = (categoryId: number, typeId?: number) =>
    `category-products:${categoryId}:${typeId ?? ""}`;

  const readCachedCategoryProducts = (targetShopId: string, categoryId: number, typeId?: number) =>
    readQueryCache<OzonProductRow[]>(targetShopId, categoryProductCacheName(categoryId, typeId))?.data ?? [];

  const writeCachedCategoryProducts = (
    targetShopId: string,
    categoryId: number,
    typeId: number | undefined,
    rows: OzonProductRow[],
  ) => {
    writeQueryCache(targetShopId, categoryProductCacheName(categoryId, typeId), rows);
  };

  const cachedProductsForUpdate = (targetShopId: string, categoryId: number, typeId?: number) =>
    readCachedCategoryProducts(targetShopId, categoryId, typeId)
      .filter((row) => row.offerId.trim())
      .map((row) => ({ offerId: row.offerId, name: row.name || row.offerId }));

  const applyCachedShopData = (id: string) => {
    const cachedWarehouses = readQueryCache<WarehouseOption[]>(id, "warehouses");
    setWarehouses(cachedWarehouses?.data ?? []);
    setWarehouseError(cachedWarehouses ? "" : "暂无本地仓库缓存，点击查询仓库后会查询 Ozon。");
    setSelectedWarehouseId((current) => current || cachedWarehouses?.data[0]?.warehouseId || "");

    const cachedCategories = readQueryCache<CategoryOption[]>(id, "categories");
    setCategories(cachedCategories?.data ?? []);
    if (cachedCategories?.data.length) {
      setResult(`已从本地缓存读取 ${cachedCategories.data.length} 个商品分类，需要更新时点击刷新类目。`);
    }
    setSelectedCategoryId((current) => {
      if (!cachedCategories?.data.length) {
        return current;
      }
      return current && cachedCategories.data.some((category) => category.id === current) ? current : "";
    });

    const cachedProducts = readQueryCache<{ source: string; rows: OzonProductRow[] }>(id, "inventory-products");
    setProductRows(cachedProducts?.data.rows ?? []);

    const cachedActions = readQueryCache<ActionRow[]>(id, "actions");
    setActions(cachedActions?.data ?? []);
    const cachedSelectedAction = readQueryCache<number | "">(id, "selected-action");
    const nextActionId = cachedSelectedAction?.data || cachedActions?.data[0]?.id || "";
    setSelectedActionId(nextActionId);
    applyCachedActionProducts(id, nextActionId);
  };

  const applyCachedActionProducts = (id: string, actionId: number | "") => {
    if (!actionId) {
      setActionProducts([]);
      setActionCandidates([]);
      setSelectedActionProductIds([]);
      setSelectedActionCandidateIds([]);
      setActionProductLastId("");
      setNextActionProductLastId("");
      setActionCandidateLastId("");
      setNextActionCandidateLastId("");
      return;
    }
    const cached = readQueryCache<{
      rows: ActionProductRow[];
      lastId: string;
      nextLastId: string;
    }>(id, `action-products:${actionId}`);
    setActionProducts(cached?.data.rows ?? []);
    setActionCandidates([]);
    setSelectedActionProductIds([]);
    setSelectedActionCandidateIds([]);
    setActionProductLastId(cached?.data.lastId ?? "");
    setNextActionProductLastId(cached?.data.nextLastId ?? "");
    setActionCandidateLastId("");
    setNextActionCandidateLastId("");
  };

  const preflightUpload = async () => {
    setChecking(true);
    try {
      const data = await api.preflightBatchUpload(uploadRequest());
      if (!templateProduct) {
        data.unshift({
          level: "warn",
          scope: "商品模板",
          message: "当前没有选择商品模板，可继续上架，但类目、尺寸、价格、属性结构可能不完整。",
          actionLabel: "设置模板",
          actionTarget: "ozon",
        });
      }
      setIssues(data);
      return data;
    } finally {
      setChecking(false);
    }
  };

  const preflightUpdate = async () => {
    setChecking(true);
    try {
      const data = await api.preflightListedUpdate(updateRequest());
      setIssues(data);
      return data;
    } finally {
      setChecking(false);
    }
  };

  const submitUpload = async () => {
    const data = await preflightUpload();
    if (hasBlockingIssues(data)) return;
    await run(async () => {
      const job = await api.startBatchUpload(uploadRequest());
      setResult(JSON.stringify(job, null, 2));
      setFriendlyMessage("上架任务已提交，可到任务记录查看进度和日志。");
      onChanged();
      onNavigate("jobs");
    });
  };

  const submitUpdate = async () => {
    const data = await preflightUpdate();
    if (hasBlockingIssues(data)) return;
    await run(async () => {
      const job = await api.startListedUpdate(updateRequest());
      setResult(JSON.stringify(job, null, 2));
      setFriendlyMessage("更新任务已提交，可到任务记录查看进度和日志。");
      onChanged();
      onNavigate("jobs");
    });
  };

  const useVideoOnlyUpdate = () => {
    setUpdateTitle(false);
    setUpdateDescription(false);
    setUpdateImages(false);
    setUpdateVideo(true);
    setUpdateRichJson(false);
    setIssues([]);
    setFriendlyMessage("已切换为只更新视频：只需要选择店铺、Excel 货号表，并填写视频链接。");
  };

  const submitCategoryVideoUpdate = async () => {
    setResult("");
    setFriendlyMessage("");
    setFriendlyTone("info");
    setInventoryFeedback({ tone: "running", message: "正在提交全类目视频更新任务，请稍等..." });
    try {
      if (!shopId) throw new Error("请先选择店铺");
      const selected = selectedCategory();
      if (!selected) throw new Error("请先选择商品分类");
      if (!selected.descriptionCategoryId) throw new Error("所选分类缺少 Ozon description_category_id");
      const videoLinks = templateVideoLinks.split("\n").map((item) => item.trim()).filter(Boolean);
      if (videoLinks.length === 0) throw new Error("请先在更新商品页或本页填写视频链接");
      const targetShopIds = normalizeShopIds(categoryVideoShopIds.length > 0 ? categoryVideoShopIds : [shopId])
        .filter((id) => shops.some((shop) => shop.id === id));
      if (targetShopIds.length === 0) throw new Error("请至少选择一个要更新视频的店铺");
      const results = [];
      const errors = [];
      for (const targetShopId of targetShopIds) {
        const targetShop = shops.find((shop) => shop.id === targetShopId);
        const cachedProducts = cachedProductsForUpdate(targetShopId, selected.descriptionCategoryId, selected.typeId);
        try {
          const job = await api.startListedUpdate({
            shopId: targetShopId,
            portraitRoot: "",
            excelPath: "",
            maxItems: undefined,
            updateTitle: false,
            updateDescription: false,
            updateImages: false,
            updateVideo: true,
            updateRichJson: false,
            templateProduct,
            templateVideoLinks: videoLinks,
            categoryUpdate: {
              categoryId: selected.descriptionCategoryId,
              typeId: selected.typeId,
              categoryName: selected.name,
              cachedProducts: cachedProducts.length > 0 ? cachedProducts : undefined,
            },
          });
          results.push({
            shopId: targetShopId,
            shopName: targetShop?.name ?? targetShopId,
            cachedProducts: cachedProducts.length,
            job,
          });
        } catch (error) {
          errors.push({
            shopId: targetShopId,
            shopName: targetShop?.name ?? targetShopId,
            message: friendlyError(error),
          });
        }
      }
      if (results.length === 0) {
        throw new Error(errors.map((item) => `${item.shopName}: ${item.message}`).join("；") || "全类目视频更新任务提交失败");
      }
      setResult(JSON.stringify({ jobs: results, errors }, null, 2));
      const cacheText = results.some((item) => item.cachedProducts > 0)
        ? "，已优先使用本地类目商品缓存"
        : "，没有缓存的店铺会在后台查询 Ozon 类目商品";
      const errorText = errors.length > 0 ? `；${errors.length} 个店铺提交失败，请查看输出详情` : "";
      const message = `已提交 ${results.length} 个店铺的全类目视频更新任务：“${selected.name}”${cacheText}${errorText}。`;
      setInventoryFeedback({ tone: "success", message });
      setFriendlyMessage(message);
      onChanged();
      onNavigate("jobs");
    } catch (error) {
      const message = friendlyError(error);
      setFriendlyTone("error");
      setFriendlyMessage(message);
      setInventoryFeedback({ tone: "error", message });
      setResult(message);
    }
  };

  const submitOrderDocuments = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      if (parseOrderNumbers(orderNumbersText).length === 0) throw new Error("请至少输入一个订单/货件编号");
      const orderNumbers = parseOrderNumbers(orderNumbersText);
      const shippingLabelUrls = orderShippingLabelText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (shippingLabelUrls.length !== orderNumbers.length) throw new Error(`物流贴单地址数量必须等于订单数量：订单 ${orderNumbers.length} 个，地址 ${shippingLabelUrls.length} 个`);
      if (new Set(shippingLabelUrls).size !== shippingLabelUrls.length) throw new Error("同一个物流贴单地址不能重复使用");
      if (!orderOutputRoot.trim()) throw new Error("请选择输出目录");
      if (!ozonSellerHarPath.trim() && !ozonSellerCookiePath.trim() && !currentShop?.ozonSellerCookieStored) {
        throw new Error("请先保存当前店铺的 Ozon 后台 Cookie，或选择 HAR/粘贴 Cookie");
      }
      if (downloadMaterials && !baiduCookie.trim()) {
        throw new Error("开启下载货号素材后，请填写百度网盘 Cookie");
      }
      if (downloadMaterials && baiduCookie.trim() !== settings.baiduCookie) {
        await saveBaiduCookie();
      }
      const job = await api.startOrderDocuments(orderDocumentsRequest());
      setResult(JSON.stringify(job, null, 2));
      setFriendlyMessage("订单文件下载任务已提交。页面会保留本次输入和下载配置。");
      onChanged();
    });
  };

  const loadOrderPostings = async () => {
    const requestId = latestOrderPostingsRequestRef.current + 1;
    latestOrderPostingsRequestRef.current = requestId;
    setResult("");
    setFriendlyMessage("");
    setFriendlyTone("info");
    try {
      if (!shopId) throw new Error("请先选择店铺");
      if (!orderDateFrom || !orderDateTo) throw new Error("请选择订单日期");
      if (orderDateFrom > orderDateTo) throw new Error("订单开始日期不能晚于结束日期");
      const rows = await api.listOrderPostings({
        shopId,
        dateFrom: orderDateFrom,
        dateTo: orderDateTo,
        status: orderStatus || undefined,
        limit: orderLimit,
      });
      if (requestId !== latestOrderPostingsRequestRef.current) return;
      setOrderRows(rows);
      setSelectedPostingNumbers([]);
      setFriendlyMessage(`已获取 ${rows.length} 个订单/货件，可勾选后下载。`);
      setResult(`订单区间 ${orderDateFrom} 至 ${orderDateTo}，共 ${rows.length} 条。`);
    } catch (error) {
      if (requestId !== latestOrderPostingsRequestRef.current) return;
      const message = friendlyError(error);
      setFriendlyTone("error");
      setFriendlyMessage(message);
      setResult(message);
    }
  };

  const applySelectedOrdersToInput = () => {
    setOrderNumbersText(selectedPostingNumbers.join("\n"));
    setFriendlyMessage(`已把 ${selectedPostingNumbers.length} 个勾选货件写入订单输入。`);
  };

  const submitSelectedOrderDocuments = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      const selectedOrderNumbers = selectedPostingNumbersInRowOrder(orderRows, selectedPostingNumbers);
      if (selectedOrderNumbers.length === 0) throw new Error("请先勾选要下载的订单/货件");
      const shippingLabelUrls = orderShippingLabelText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (shippingLabelUrls.length !== selectedOrderNumbers.length) throw new Error(`物流贴单地址数量必须等于订单数量：订单 ${selectedOrderNumbers.length} 个，地址 ${shippingLabelUrls.length} 个`);
      if (new Set(shippingLabelUrls).size !== shippingLabelUrls.length) throw new Error("同一个物流贴单地址不能重复使用");
      if (!orderOutputRoot.trim()) throw new Error("请选择输出目录");
      if (!ozonSellerHarPath.trim() && !ozonSellerCookiePath.trim() && !currentShop?.ozonSellerCookieStored) {
        throw new Error("请先保存当前店铺的 Ozon 后台 Cookie，或选择 HAR/粘贴 Cookie");
      }
      if (downloadMaterials && !baiduCookie.trim()) {
        throw new Error("开启下载货号素材后，请填写百度网盘 Cookie");
      }
      if (downloadMaterials && baiduCookie.trim() !== settings.baiduCookie) {
        await saveBaiduCookie();
      }
      const job = await api.startOrderDocuments(orderDocumentsRequest(selectedOrderNumbers));
      setOrderNumbersText(selectedOrderNumbers.join("\n"));
      setResult(JSON.stringify(job, null, 2));
      setFriendlyMessage("勾选订单文件下载任务已提交。");
      onChanged();
    });
  };

  const startFollowSync = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      const job = await api.startFollowSync(shopId, followPriceMultiplier);
      setResult(JSON.stringify(job, null, 2));
      setFriendlyMessage("跟卖同步任务已提交，可到任务记录查看每个商品的补齐结果。");
      onChanged();
      onNavigate("jobs");
    });
  };

  const startFollowAutomation = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      const job = await api.startFollowAutomation(followAutomationRequest());
      setResult(JSON.stringify(job, null, 2));
      setFriendlyMessage("跟卖自动化已启动，会按设置间隔循环执行；需要停止时到任务记录取消。");
      onChanged();
      onNavigate("jobs");
    });
  };

  const saveListingMaintenanceConfig = async () => {
    await run(async () => {
      if (!currentShop) throw new Error("请先选择店铺");
      const draft = {
        ...shopToDraft(currentShop),
        maintenanceWarehouseId: typeof maintenanceWarehouseId === "number" ? maintenanceWarehouseId : undefined,
        maintenanceStock,
        maintenanceStockEnabled: maintenanceAutoStock,
        maintenanceBarcodeEnabled: maintenanceAutoBarcode,
        maintenanceActionEnabled: maintenanceAutoAction,
        maintenanceIntervalMinutes: LISTING_MAINTENANCE_INTERVAL_MINUTES,
        maintenanceActionConfigs,
      };
      const saved = await api.saveShop(draft);
      setShopMessage(`${saved.name} 自动运维配置已保存。`);
      setFriendlyMessage("店铺自动运维配置已保存。");
      await onChanged();
    });
  };

  const startListingMaintenance = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      const request = listingMaintenanceRequest();
      if (!(request.autoUpdateStock || request.autoGenerateBarcode || request.autoAddToAction)) {
        throw new Error("请至少选择库存、条码或活动中的一个自动运维任务");
      }
      const job = await api.startListingMaintenance(request);
      setResult(JSON.stringify(job, null, 2));
      setFriendlyMessage("店铺定时运维已启动：每 2 小时执行一轮运维，完成后任务自动结束。");
      await onChanged();
    });
  };

  const startAllListingMaintenance = async () => {
    await run(async () => {
      const targets = enabledShops.filter(isListingMaintenanceEnabledForShop);
      if (targets.length === 0) {
        throw new Error("没有可执行定时运维的已启用店铺，请先启用店铺或保存运维配置。");
      }
      const started: Array<{ shopId: string; shopName: string; jobId: string }> = [];
      const failed: Array<{ shopId: string; shopName: string; message: string }> = [];
      for (const target of targets) {
        try {
          const job = await api.startListingMaintenance(listingMaintenanceRequestForShop(target));
          started.push({ shopId: target.id, shopName: target.name, jobId: job.id });
        } catch (error) {
          failed.push({ shopId: target.id, shopName: target.name, message: friendlyError(error) });
        }
      }
      if (started.length === 0) {
        throw new Error(`全部店铺定时运维启动失败：${failed.map((item) => `${item.shopName} ${item.message}`).join("；")}`);
      }
      setResult(JSON.stringify({ started, failed }, null, 2));
      if (failed.length > 0) setFriendlyTone("error");
      setFriendlyMessage(`已为 ${started.length} 个店铺启动定时运维${failed.length > 0 ? `，${failed.length} 个店铺启动失败，请查看结果。` : "。"}`);
      await onChanged();
    });
  };

  const pauseListingMaintenance = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      if (!runningListingMaintenanceJob) throw new Error("当前店铺没有正在运行的定时运维任务");
      const cancelled = await api.cancelJob(runningListingMaintenanceJob.id);
      if (!cancelled) throw new Error("任务已结束，无法继续暂停");
      setFriendlyMessage("店铺定时运维已暂停。");
      await onChanged();
    });
  };

  const pauseAllListingMaintenance = async () => {
    await run(async () => {
      if (runningListingMaintenanceJobs.length === 0) throw new Error("没有正在运行的定时运维任务");
      const stopped: string[] = [];
      const failed: Array<{ jobId: string; shopId?: string; message: string }> = [];
      for (const job of runningListingMaintenanceJobs) {
        try {
          const cancelled = await api.cancelJob(job.id);
          if (cancelled) {
            stopped.push(job.id);
          } else {
            failed.push({ jobId: job.id, shopId: job.inputPath, message: "任务已结束，无法继续停止" });
          }
        } catch (error) {
          failed.push({ jobId: job.id, shopId: job.inputPath, message: friendlyError(error) });
        }
      }
      setResult(JSON.stringify({ stopped, failed }, null, 2));
      if (failed.length > 0) setFriendlyTone("error");
      setFriendlyMessage(`已停止 ${stopped.length} 个店铺定时运维${failed.length > 0 ? `，${failed.length} 个任务停止失败，请查看结果。` : "。"}`);
      await onChanged();
    });
  };

  const saveBaiduCookie = async () => {
    const cookie = baiduCookie.trim();
    if (!cookie) throw new Error("请先填写百度网盘 Cookie");
    if (!hasBaiduBdussCookie(cookie)) throw new Error("百度网盘 Cookie 中缺少有效 BDUSS");
    const saved = await api.saveSettings({ ...settings, baiduCookie: cookie });
    setBaiduCookie(saved.baiduCookie);
    onChanged();
  };

  const loadZeroStock = async () => {
    await run(async () => {
      const rows = await api.listOzonProducts(shopId, "EMPTY_STOCK", 100);
      cacheProductRows(rows, "zero-stock");
      setResult(`已拉取 ${rows.length} 个零库存商品。`);
    });
  };

  const loadNoBarcode = async () => {
    await run(async () => {
      const rows = await api.listOzonProducts(shopId, "ALL", 1000);
      const filtered = rows.filter((row) => row.hasBarcode !== true);
      cacheProductRows(filtered, "no-barcode");
      setResult(`已拉取 ${filtered.length} 个无条码商品。`);
    });
  };

  const loadCategories = async (targetShopId = shopId) => {
    if (!targetShopId) throw new Error("请先选择店铺");
    const data = await api.listCategories(targetShopId);
    setCategories(data);
    writeQueryCache(targetShopId, "categories", data);
    setSelectedCategoryId((current) => {
      if (data.length === 0) return current;
      if (current && data.some((category) => category.id === current)) return current;
      const keyword = categoryKeyword.trim().toLowerCase();
      if (!keyword) return "";
      const matches = data.filter((category) => categorySearchText(category).includes(keyword));
      const exact = matches.find((category) => category.name.toLowerCase() === keyword);
      return (exact ?? (matches.length === 1 ? matches[0] : undefined))?.id ?? "";
    });
    setResult(`已加载 ${data.length} 个商品分类。`);
  };

  const addMaintenanceActionConfig = () => {
    const category = categories.find((item) => item.id === Number(maintenanceActionCategoryId));
    const action = actions.find((item) => item.id === Number(maintenanceActionId));
    if (!category?.descriptionCategoryId) throw new Error("请先选择一个可用于 Ozon 的商品类目");
    if (!action) throw new Error("请先选择活动");
    if (!maintenanceActionPrice.trim()) throw new Error("请填写活动价格");
    const config: ListingMaintenanceActionConfig = {
      categoryId: category.descriptionCategoryId,
      categoryName: category.name,
      actionId: action.id,
      actionTitle: action.title,
      actionPrice: maintenanceActionPrice.trim(),
      actionStock: maintenanceActionStock || 50,
    };
    setMaintenanceActionConfigs((current) => [
      ...current.filter((item) => !(item.categoryId === config.categoryId && item.actionId === config.actionId)),
      config,
    ]);
    setMaintenanceAutoAction(true);
    setMaintenanceActionPrice("");
  };

  const removeMaintenanceActionConfig = (categoryId: number, actionId: number) => {
    setMaintenanceActionConfigs((current) => current.filter((item) => item.categoryId !== categoryId || item.actionId !== actionId));
  };

  const loadCategoryProducts = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    const selected = selectedCategory();
    if (!selected) throw new Error("请先选择商品分类");
    if (!selected?.descriptionCategoryId) throw new Error("所选分类缺少 Ozon description_category_id");
    const rows = await api.listProductsByCategory(
      shopId,
      selected.descriptionCategoryId,
      selected.typeId,
      categoryLimit,
    );
    cacheProductRows(rows, `category:${selected.descriptionCategoryId}:${selected.typeId ?? ""}`);
    writeCachedCategoryProducts(shopId, selected.descriptionCategoryId, selected.typeId, rows);
    setResult(`已按分类拉取 ${rows.length} 个商品。`);
  };

  const updateSelectedCategoryProducts = async (mode: CategoryUpdateMode) => {
    setResult("");
    setFriendlyMessage("");
    setFriendlyTone("info");
    setInventoryFeedback({ tone: "running", message: "正在提交全类目更新到 Ozon，请稍等..." });
    try {
      if (!shopId) throw new Error("请先选择店铺");
      const selected = selectedCategory();
      if (!selected) throw new Error("请先选择商品分类");
      if (!selected.descriptionCategoryId) throw new Error("所选分类缺少 Ozon description_category_id");
      const updateStock = mode === "stock" || mode === "both";
      const updatePrice = mode === "price" || mode === "both";
      const data = await api.updateCategoryProducts({
        shopId,
        categoryId: selected.descriptionCategoryId,
        typeId: selected.typeId,
        cachedProducts: readCachedCategoryProducts(shopId, selected.descriptionCategoryId, selected.typeId),
        warehouseId: typeof selectedWarehouseId === "number" ? selectedWarehouseId : undefined,
        stock: stockValue,
        price: newPrice.trim(),
        oldPrice: newOldPrice.trim(),
        currencyCode: currencyCode.trim(),
        updateStock,
        updatePrice,
      });
      setResult(JSON.stringify(data, null, 2));
      const actionName = updateStock && updatePrice ? "库存和价格" : updateStock ? "库存" : "价格";
      const updatedCount = responseNumber(data, "total") ?? 0;
      const stockBatches = responseNumber(data, "stockBatches") ?? 0;
      const priceBatches = responseNumber(data, "priceBatches") ?? 0;
      const details = [
        `${updatedCount} 个商品`,
        updateStock ? `库存更新为 ${stockValue}` : "",
        updateStock ? `仓库 ${selectedWarehouseId || "-"}` : "",
        updatePrice ? `售价更新为 ${newPrice.trim()}` : "",
        updatePrice && newOldPrice.trim() ? `划线价更新为 ${newOldPrice.trim()}` : "",
        updateStock ? `库存 ${stockBatches} 批次` : "",
        updatePrice ? `价格 ${priceBatches} 批次` : "",
      ].filter(Boolean).join("，");
      const message = `全类目${actionName}更新已提交：“${selected.name}”，${details}。`;
      setInventoryFeedback({ tone: "success", message });
      setFriendlyMessage(message);
    } catch (error) {
      const message = friendlyError(error);
      setFriendlyTone("error");
      setFriendlyMessage(message);
      setInventoryFeedback({ tone: "error", message });
      setResult(message);
    }
  };

  const categorySearchText = (category: CategoryOption) =>
    `${category.name} ${category.id} ${category.descriptionCategoryId ?? ""} ${category.typeId ?? ""}`.toLowerCase();

  const filteredCategories = categories.filter((category) => {
    const keyword = categoryKeyword.trim().toLowerCase();
    if (!keyword) return true;
    return categorySearchText(category).includes(keyword);
  });

  const selectedCategory = () => {
    const current = categories.find((category) => category.id === Number(selectedCategoryId));
    if (current) return current;
    const keyword = categoryKeyword.trim().toLowerCase();
    if (!keyword) return undefined;
    const exact = filteredCategories.find((category) => category.name.toLowerCase() === keyword);
    return exact ?? (filteredCategories.length === 1 ? filteredCategories[0] : undefined);
  };

  useEffect(() => {
    const keyword = categoryKeyword.trim().toLowerCase();
    if (!keyword) return;
    const current = categories.find((category) => category.id === Number(selectedCategoryId));
    const exact = filteredCategories.find((category) => category.name.toLowerCase() === keyword);
    const next = exact ?? (filteredCategories.length === 1 ? filteredCategories[0] : undefined);
    if (next && current?.id !== next.id) {
      setSelectedCategoryId(next.id);
    } else if (current && !categorySearchText(current).includes(keyword)) {
      setSelectedCategoryId("");
    }
    setProductRows([]);
    setResult(`已筛选到 ${filteredCategories.length} 个分类，请确认分类后点击查询。`);
  }, [categoryKeyword, categories]);

  const loadActions = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    const data = await api.listActions(shopId);
    const rows = parseActions(data);
    setActions(rows);
    writeQueryCache(shopId, "actions", rows);
    const nextActionId = selectedActionId || rows[0]?.id || "";
    setSelectedActionId(nextActionId);
    writeQueryCache(shopId, "selected-action", nextActionId);
    applyCachedActionProducts(shopId, nextActionId);
    setFriendlyMessage(`已加载 ${rows.length} 个活动。请选择活动后继续查询可参加商品或已参加商品。`);
    setResult(`已加载 ${rows.length} 个活动。`);
  };

  const loadActionProducts = async (lastId = "") => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!selectedActionId) throw new Error("请先选择活动");
    const data = await api.listActionProducts(shopId, Number(selectedActionId), actionProductLimit, lastId);
    const rows = parseActionProducts(data);
    const enrichedRows = await enrichActionProducts(shopId, rows);
    const nextLastId = extractNextLastId(data);
    setActionProducts(enrichedRows);
    setSelectedActionProductIds([]);
    setActionProductLastId(lastId);
    setNextActionProductLastId(nextLastId);
    writeQueryCache(shopId, "selected-action", selectedActionId);
    writeQueryCache(shopId, `action-products:${selectedActionId}`, {
      rows: enrichedRows.map(lightweightActionProductRow),
      lastId,
      nextLastId,
    });
    setFriendlyMessage(`已加载 ${enrichedRows.length} 个已参加商品。要删除时，请在“已参加商品”表中勾选。`);
    setResult(JSON.stringify(data, null, 2));
  };

  const loadActionCandidates = async (lastId = "") => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!selectedActionId) throw new Error("请先选择活动");
    const data = await api.listActionCandidates(shopId, Number(selectedActionId), actionProductLimit, lastId);
    const rows = parseActionProducts(data);
    const enrichedRows = await enrichActionProducts(shopId, rows);
    const nextLastId = extractNextLastId(data);
    setActionCandidates(enrichedRows);
    setSelectedActionCandidateIds([]);
    setActionCandidateLastId(lastId);
    setNextActionCandidateLastId(nextLastId);
    setFriendlyMessage(`已加载 ${enrichedRows.length} 个可参加商品。要新增时，请在“可参加商品”表中勾选。`);
    setResult(JSON.stringify(data, null, 2));
  };

  const addSelectedProductsToAction = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!selectedActionId) throw new Error("请先选择活动");
    const selectedIds = new Set(selectedActionCandidateIds);
    const selectedRows = actionCandidates.filter((product) => product.productId && selectedIds.has(product.productId));
    if (selectedRows.length === 0) throw new Error("请先查询可参加商品，并勾选要新增的商品");
    const productsPayload = selectedRows.map((product) => buildActionProductPayload(product, actionPrice, actionStock));
    const data = await api.activateActionProducts(shopId, Number(selectedActionId), productsPayload);
    setSelectedActionCandidateIds([]);
    await loadActionProducts("");
    setFriendlyMessage(`已提交 ${productsPayload.length} 个商品参加活动，并刷新了已参加商品列表。`);
    setResult(JSON.stringify({ total: productsPayload.length, data }, null, 2));
  };

  const removeSelectedProductsFromAction = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!selectedActionId) throw new Error("请先选择活动");
    if (selectedActionProductIds.length === 0) throw new Error("请先在已参加商品列表中勾选要删除的商品");
    const data = await api.deactivateActionProducts(shopId, Number(selectedActionId), selectedActionProductIds);
    setSelectedActionProductIds([]);
    await loadActionProducts("");
    setFriendlyMessage(`已提交删除 ${selectedActionProductIds.length} 个活动商品，并刷新了已参加商品列表。`);
    setResult(JSON.stringify({ total: selectedActionProductIds.length, data }, null, 2));
  };

  const removeAllProductsFromAction = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!selectedActionId) throw new Error("请先选择活动");
    const action = actions.find((item) => item.id === Number(selectedActionId));
    const actionName = action?.title ?? selectedActionId;
    if (pendingDeleteAllActionId !== Number(selectedActionId)) {
      setPendingDeleteAllActionId(Number(selectedActionId));
      setFriendlyMessage(`请再次点击“确认删除当前活动所有商品”，将删除活动“${actionName}”下全部已参加商品。`);
      setResult(`待确认：删除当前活动“${actionName}”下全部已参加商品。`);
      return;
    }
    const data = await api.deactivateAllActionProducts(shopId, Number(selectedActionId));
    setPendingDeleteAllActionId("");
    setSelectedActionProductIds([]);
    await loadActionProducts("");
    setFriendlyMessage(`已提交删除当前活动“${actionName}”的所有商品，并刷新了已参加商品列表。`);
    setResult(JSON.stringify(data, null, 2));
  };

  const loadAnalytics = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!analyticsDateFrom || !analyticsDateTo) throw new Error("请选择统计日期");
    if (analyticsDateFrom > analyticsDateTo) throw new Error("开始日期不能晚于结束日期");
    if (analyticsDateTo > analyticsMaxDate) {
      throw new Error(`Ozon 当前最多只能查询到 ${analyticsMaxDate}（按 UTC 日期）`);
    }
    const rows = await api.listProductAnalytics(
      shopId,
      analyticsDateFrom,
      analyticsDateTo,
      analyticsLimit,
    );
    const sorted = [...rows].sort((a, b) => b.cardViews - a.cardViews);
    setAnalyticsRows(sorted);
    setSelectedAnalyticsProductIds([]);
    setMergeConfirmPending(false);
    setFriendlyMessage(`已加载 ${sorted.length} 个商品的浏览量，当前筛选显示 ${sorted.filter((row) => row.cardViews >= minimumCardViews).length} 个。`);
    setResult(`统计区间 ${analyticsDateFrom} 至 ${analyticsDateTo}，共 ${sorted.length} 个商品。`);
  };

  const mergeSelectedAnalyticsProducts = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (selectedAnalyticsProductIds.length < 2) throw new Error("请至少勾选 2 个商品");
    if (!mergeConfirmPending) {
      setMergeConfirmPending(true);
      setFriendlyMessage(`将按“类目 + 类型”分组，每组最多 20 个，处理 ${selectedAnalyticsProductIds.length} 个商品。请再次点击确认。`);
      setResult(`待确认：按同类目每 20 个合并商品卡，共选择 ${selectedAnalyticsProductIds.length} 个商品。`);
      return;
    }
    const data = await api.mergeProductCards(shopId, selectedAnalyticsProductIds);
    setMergeConfirmPending(false);
    setFriendlyMessage("商品卡合并属性已提交 Ozon；接口会跳过类目不一致、缺少型号属性或不足 2 个的分组。");
    setResult(JSON.stringify(data, null, 2));
  };

  const applyTemplate = (payload: unknown, status: string) => {
    setTemplateProduct(payload);
    setTemplateJson(JSON.stringify(payload, null, 2));
    setTemplateStatus(status);
  };

  const clearTemplateState = () => {
    setSelectedTemplateId("");
    setTemplateName("");
    setTemplateProduct(undefined);
    setTemplateJson("");
    setTemplateStatus("未选择商品模板");
  };

  const loadTemplates = async (autoApplySaved = false) => {
    const data = await api.listTemplates(PRODUCT_TEMPLATE_KIND);
    setTemplates(data);
    if (autoApplySaved) {
      const rememberedId = readSelectedProductTemplateId() || savedUpdateDraft.selectedTemplateId || selectedTemplateId;
      const selected = data.find((template) => template.id === rememberedId)
        ?? data.find((template) => template.name === savedUpdateDraft.templateName && savedUpdateDraft.templateName)
        ?? (data.length === 1 ? data[0] : undefined);
      if (selected) {
        setSelectedTemplateId(selected.id);
        setTemplateName(selected.name);
        writeSelectedProductTemplateId(selected.id);
        applyTemplate(selected.payload, `已自动载入保存模板：${selected.name}`);
      } else {
        writeSelectedProductTemplateId("");
      }
    }
  };

  const fetchOnlineTemplate = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!templateOfferId.trim()) throw new Error("请输入模板商品货号");
    const [info, attrs, description] = await Promise.all([
      api.getProductInfo(shopId, [templateOfferId.trim()]),
      api.getProductAttributes(shopId, [templateOfferId.trim()]),
      api.getProductDescription(shopId, templateOfferId.trim()),
    ]);
    const product = firstResultItem(info);
    const attributes = firstResultItem(attrs);
    const descriptionItem = firstResultItem(description) ?? description;
    const mergedAttributes = extractAttributes(attributes, product);
    const template = {
      ...(isRecord(product) ? product : {}),
      ...(isRecord(attributes) ? attributes : {}),
      ...(isRecord(descriptionItem) ? descriptionItem : {}),
      ...(mergedAttributes.length ? { attributes: mergedAttributes } : {}),
    };
    applyTemplate(template, `已读取线上模板：${templateOfferId.trim()}`);
  };

  const applyJsonTemplate = () => {
    if (!templateJson.trim()) throw new Error("请先粘贴模板 JSON");
    const payload = JSON.parse(templateJson);
    applyTemplate(payload, "已应用粘贴的 JSON 模板");
  };

  const saveCurrentTemplate = async () => {
    const payload = readCurrentTemplatePayload(templateProduct, templateJson);
    const saved = await api.saveTemplate({
      id: selectedTemplateId || undefined,
      kind: PRODUCT_TEMPLATE_KIND,
      name: templateName.trim() || templateOfferId.trim() || "商品导入模板",
      payload,
    });
    const data = await api.listTemplates(PRODUCT_TEMPLATE_KIND).catch(() => []);
    const nextTemplates = data.some((template) => template.id === saved.id)
      ? data
      : [saved, ...templates.filter((template) => template.id !== saved.id)];
    setTemplates(nextTemplates);
    setSelectedTemplateId(saved.id);
    setTemplateName(saved.name);
    applyTemplate(saved.payload, `模板已保存：${saved.name}`);
    writeSelectedProductTemplateId(saved.id);
    setFriendlyTone("info");
    setFriendlyMessage(`模板已保存：${saved.name}，下次进入会自动载入。`);
    setTemplateStatus(`模板已保存：${saved.name}`);
  };

  const selectTemplate = (id: string) => {
    setSelectedTemplateId(id);
    writeSelectedProductTemplateId(id);
    if (!id) {
      clearTemplateState();
      return;
    }
    const selected = templates.find((template) => template.id === id);
    if (!selected) return;
    setTemplateName(selected.name);
    applyTemplate(selected.payload, `已选择保存模板：${selected.name}`);
  };

  const deleteCurrentTemplate = async () => {
    if (!selectedTemplateId) return;
    await api.deleteTemplate(selectedTemplateId);
    writeSelectedProductTemplateId("");
    setSelectedTemplateId("");
    setTemplateName("");
    await loadTemplates();
    setTemplateStatus("模板已删除，当前任务未使用模板");
    setTemplateProduct(undefined);
    setTemplateJson("");
  };

  const clearTemplate = () => {
    writeSelectedProductTemplateId("");
    clearTemplateState();
    setTemplateOfferId("");
  };

  useEffect(() => {
    if (shopId) return;
    const firstEnabledShop = shops.find((shop) => shop.enabled) ?? shops[0];
    if (firstEnabledShop) {
      setShopId(firstEnabledShop.id);
    }
  }, [shopId, shops]);

  useEffect(() => {
    setAnalyticsRows([]);
    setSelectedAnalyticsProductIds([]);
    setMergeConfirmPending(false);
    setOrderRows([]);
    setSelectedPostingNumbers([]);
    if (shopId) {
      const cachedWarehouses = readQueryCache<WarehouseOption[]>(shopId, "warehouses");
      const cachedCategories = readQueryCache<CategoryOption[]>(shopId, "categories");
      applyCachedShopData(shopId);
      if ((!cachedWarehouses || !cachedCategories) && !autoLoadedShopDataRef.current.has(shopId)) {
        autoLoadedShopDataRef.current.add(shopId);
        if (!cachedWarehouses) {
          void loadWarehouses(shopId);
        }
        if (!cachedCategories) {
          void loadCategories(shopId).catch((error) => setResult(String(error)));
        }
      }
    } else {
      setWarehouses([]);
      setProductRows([]);
      setCategories([]);
      setSelectedCategoryId("");
      setActions([]);
      setSelectedActionId("");
      setActionProducts([]);
      setActionCandidates([]);
      setSelectedActionProductIds([]);
      setSelectedActionCandidateIds([]);
      setActionProductLastId("");
      setNextActionProductLastId("");
      setWarehouseError("请先在店铺管理里保存店铺，并选择店铺后获取仓库。");
    }
  }, [shopId]);

  useEffect(() => {
    const validShopIds = new Set(enabledShops.map((shop) => shop.id));
    setCategoryVideoShopIds((current) => {
      const next = normalizeShopIds([
        ...current.filter((id) => validShopIds.has(id)),
        shopId && validShopIds.has(shopId) ? shopId : "",
      ]);
      return next.join("|") === current.join("|") ? current : next;
    });
  }, [shops, shopId]);

  useEffect(() => {
    loadTemplates(true).catch((error) => setResult(String(error)));
  }, []);

  const openShopCenter = (id: string) => {
    setShopId(id);
    setTab("upload");
    setShopCenterOpen(true);
  };

  const openCreateShop = () => {
    setEditingShop(undefined);
    setShopDialogOpen(true);
  };

  const openEditShop = (shop: Shop) => {
    setEditingShop(shop);
    setShopDialogOpen(true);
  };
  const currentShopRole = currentShop?.shopRole ?? "main";
  const currentShopStatusItems = [
    { label: "店铺 ID", value: currentShop?.id || "-" },
    { label: "关联账号", value: currentShop?.clientId || "-" },
    {
      label: currentShopRole === "follower" ? "跟卖主店" : "跟卖店铺",
      value: currentShopRole === "follower"
        ? (currentMainShop?.name ?? currentShop?.followsShopId ?? "未选择主店")
        : `${followerShops.length} 个`,
    },
    { label: "商品水印", value: currentShop?.watermarkPath ? "已设置" : "未设置" },
    { label: "API Key", value: currentShop?.apiKeyStored ? "已保存" : "未保存" },
  ];
  const activeTask = TASK_TABS.find((item) => item.key === tab) ?? TASK_TABS[0];

  useEffect(() => {
    onHeaderChange?.(
      <div className="ozon-topbar-context">
        <strong className="ozon-topbar-shop-name">{currentShop?.name || "未选择店铺"}</strong>
        <TaskNavigation activeTab={tab} onSelect={setTab} />
      </div>,
    );
  }, [currentShop?.id, currentShop?.name, onHeaderChange, tab]);

  useEffect(() => () => onHeaderChange?.(null), [onHeaderChange]);

  if (!shopCenterOpen) {
    return (
      <div className="content-grid">
        <ShopMaintenanceHomePanel
          shop={currentShop}
          shops={shops}
          runningJobs={runningListingMaintenanceJobs}
          runningJob={runningListingMaintenanceJob}
          canStart={maintenanceEnabled}
          onStart={startListingMaintenance}
          onPause={pauseListingMaintenance}
          onStartAll={startAllListingMaintenance}
          onPauseAll={pauseAllListingMaintenance}
        />
        <ShopManagementPanel
          shops={shops}
          selectedShopId={shopId}
          onSelectShop={setShopId}
          onOpenShopCenter={openShopCenter}
          onCreateShop={openCreateShop}
          onEditShop={openEditShop}
        />
        {shopMessage ? <section className="panel"><span className="badge">{shopMessage}</span></section> : null}
        {shopDialogOpen ? (
          <ShopEditorDialog
            shop={editingShop}
            shops={shops}
            onClose={() => setShopDialogOpen(false)}
            onSaved={async (saved) => {
              setShopMessage(`${saved.name} 已保存。`);
              setShopDialogOpen(false);
              setEditingShop(undefined);
              setShopId(saved.id);
              await onChanged();
            }}
            onDeleted={async () => {
              setShopMessage("店铺已删除。");
              setShopDialogOpen(false);
              setEditingShop(undefined);
              await onChanged();
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="content-grid">
      <section className="panel shop-workspace shop-workspace-center">
        <div className="shop-detail">
          <div className="shop-hero">
            <div className="shop-hero-main">
              <div className="shop-avatar large">{currentShop?.name.slice(0, 1).toUpperCase() || "店"}</div>
              <div className="shop-hero-copy">
                <div className="shop-hero-title">
                  <span className={currentShop?.enabled ? "status-label ok" : "status-label warn"}>{currentShop?.enabled ? "店铺启用" : "店铺停用"}</span>
                  <span className="status-label neutral">{currentShopRole === "follower" ? "跟卖店铺" : "主店铺"}</span>
                </div>
                <h2>{currentShop?.name || "未选择店铺"}</h2>
                <p>{activeTask.label}：{activeTask.description}</p>
              </div>
            </div>
            <div className="shop-actions">
              <label className="shop-switcher">
                <span>当前店铺</span>
                <select value={shopId} onChange={(event) => setShopId(event.target.value)}>
                  <option value="">选择店铺</option>
                  {shops.map((shop) => (
                    <option key={shop.id} value={shop.id}>{shop.name} ({shop.clientId})</option>
                  ))}
                </select>
              </label>
              <div className="shop-action-buttons">
                <button className="secondary-button" onClick={() => setShopCenterOpen(false)}>返回店铺管理</button>
                {currentShop ? <button className="secondary-button" onClick={() => openEditShop(currentShop)}>编辑店铺</button> : null}
                <button className="secondary-button" onClick={() => onNavigate("jobs")}>任务列表</button>
              </div>
            </div>
          </div>
          <div className="shop-center-summary">
            {currentShopStatusItems.map((item) => (
              <div key={item.label} className="shop-summary-item">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          <div className="shop-center-body">
            <div className="shop-primary-workflow">
              <span className="eyebrow">推荐起点</span>
              <h3>先完成批量上架</h3>
              <p>检查店铺、Excel 和 SKU 图片匹配后提交任务。上架完成后，再进入更新、订单文件和库存活动。</p>
              <button className="primary-button" onClick={() => setTab("upload")}>进入上架商品</button>
            </div>
            <TaskNavigation activeTab={tab} onSelect={setTab} />
          </div>
        </div>
      </section>

      {friendlyMessage ? (
        <section className={friendlyTone === "error" ? "panel feedback-panel error" : "panel feedback-panel"}>
          <strong>{friendlyTone === "error" ? "操作失败" : "操作提示"}</strong>
          <span>{friendlyMessage}</span>
        </section>
      ) : null}

      {tab === "upload" ? (
        <>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>批量上架</h2>
                <p className="muted">先检查店铺、Excel 和 SKU 图片匹配，再提交 Ozon import。</p>
              </div>
              <div className="toolbar">
                <button className="secondary-button" onClick={preflightUpload} disabled={checking}>{checking ? "检查中" : "预检查"}</button>
                <button className="primary-button" onClick={submitUpload}>提交上架任务</button>
              </div>
            </div>
            <CommonUploadFields
              portraitRoot={portraitRoot}
              setPortraitRoot={setPortraitRoot}
              excelPath={excelPath}
              setExcelPath={setExcelPath}
              maxItems={maxItems}
              setMaxItems={setMaxItems}
              templateVideoLinks={templateVideoLinks}
              setTemplateVideoLinks={setTemplateVideoLinks}
            />
            <AutoUploadPostProcessPanel
              enabled={autoPostProcess}
              setEnabled={setAutoPostProcess}
              warehouses={warehouses}
              selectedWarehouseId={selectedWarehouseId}
              setSelectedWarehouseId={setSelectedWarehouseId}
              stockValue={stockValue}
              setStockValue={setStockValue}
              actions={actions}
              selectedActionId={selectedActionId}
              setSelectedActionId={setSelectedActionId}
              actionPrice={actionPrice}
              setActionPrice={setActionPrice}
              actionStock={actionStock}
              setActionStock={setActionStock}
              refreshWarehouses={() => loadWarehouses(shopId)}
              refreshActions={() => run(loadActions)}
            />
          </section>
            <ProductTemplatePanel
            shopId={shopId}
            templates={templates}
            selectedTemplateId={selectedTemplateId}
            selectTemplate={selectTemplate}
            templateName={templateName}
            setTemplateName={setTemplateName}
            templateOfferId={templateOfferId}
            setTemplateOfferId={setTemplateOfferId}
            templateJson={templateJson}
            setTemplateJson={setTemplateJson}
            templateStatus={templateStatus}
            templateProduct={templateProduct}
            fetchOnlineTemplate={() => run(fetchOnlineTemplate)}
            applyJsonTemplate={() => run(async () => applyJsonTemplate())}
            saveCurrentTemplate={() => run(saveCurrentTemplate)}
            deleteCurrentTemplate={() => run(deleteCurrentTemplate)}
            clearTemplate={clearTemplate}
          />
          <PreflightSection issues={issues} onNavigate={onNavigate} />
        </>
      ) : null}

      {tab === "update" ? (
        <>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>已上架更新</h2>
                <p className="muted">按货号读取线上商品，可选择更新标题、简介、图片、视频和富内容；只更新视频时不需要图片目录。</p>
              </div>
              <div className="toolbar">
                <button className="secondary-button" onClick={useVideoOnlyUpdate}>只更新视频</button>
                <button className="secondary-button" onClick={preflightUpdate} disabled={checking}>{checking ? "检查中" : "预检查"}</button>
                <button className="primary-button" onClick={submitUpdate}>提交更新任务</button>
              </div>
            </div>
            <CommonUploadFields
              portraitRoot={portraitRoot}
              setPortraitRoot={setPortraitRoot}
              excelPath={excelPath}
              setExcelPath={setExcelPath}
              maxItems={maxItems}
              setMaxItems={setMaxItems}
              templateVideoLinks={templateVideoLinks}
              setTemplateVideoLinks={setTemplateVideoLinks}
            />
            {!updateImages ? (
              <div className="operation-feedback">
                <strong>当前不会检查图片目录</strong>
                <span>未勾选“更新图片”时，图片目录只作为结果表备用输出目录；只更新视频时 Excel 只需要货号列。</span>
              </div>
            ) : null}
            <div className="check-grid">
              {[
                ["updateTitle", "更新标题", updateTitle, setUpdateTitle],
                ["updateDescription", "更新简介", updateDescription, setUpdateDescription],
                ["updateImages", "更新图片", updateImages, setUpdateImages],
                ["updateVideo", "更新视频", updateVideo, setUpdateVideo],
                ["updateRichJson", "更新 JSON 富内容", updateRichJson, setUpdateRichJson],
              ].map(([key, label, checked, setter]) => (
                <label key={key as string} className="check-card">
                  <input type="checkbox" checked={checked as boolean} onChange={(event) => (setter as (value: boolean) => void)(event.target.checked)} />
                  {label as string}
                </label>
              ))}
            </div>
          </section>
            <ProductTemplatePanel
            shopId={shopId}
            templates={templates}
            selectedTemplateId={selectedTemplateId}
            selectTemplate={selectTemplate}
            templateName={templateName}
            setTemplateName={setTemplateName}
            templateOfferId={templateOfferId}
            setTemplateOfferId={setTemplateOfferId}
            templateJson={templateJson}
            setTemplateJson={setTemplateJson}
            templateStatus={templateStatus}
            templateProduct={templateProduct}
            fetchOnlineTemplate={() => run(fetchOnlineTemplate)}
            applyJsonTemplate={() => run(async () => applyJsonTemplate())}
            saveCurrentTemplate={() => run(saveCurrentTemplate)}
            deleteCurrentTemplate={() => run(deleteCurrentTemplate)}
            clearTemplate={clearTemplate}
          />
          <PreflightSection issues={issues} onNavigate={onNavigate} />
        </>
      ) : null}

      {tab === "orders" ? (
        <>
          <section className="panel task-brief">
            <div>
              <h2>订单文件下载</h2>
              <p className="muted">输入订单或货件编号，程序会为每个编号创建文件夹，并下载面单、条码、拣货单和可选货号素材。</p>
            </div>
            <div className="toolbar">
              <button className="primary-button" onClick={submitOrderDocuments}>开始下载</button>
              <button className="secondary-button" onClick={() => onNavigate("jobs")}>查看任务</button>
            </div>
          </section>

          <OrderPostingPanel
            dateFrom={orderDateFrom}
            setDateFrom={setOrderDateFrom}
            dateTo={orderDateTo}
            setDateTo={setOrderDateTo}
            status={orderStatus}
            setStatus={setOrderStatus}
            limit={orderLimit}
            setLimit={setOrderLimit}
            rows={orderRows}
            selectedPostingNumbers={selectedPostingNumbers}
            setSelectedPostingNumbers={setSelectedPostingNumbers}
            loadOrders={loadOrderPostings}
            applySelected={applySelectedOrdersToInput}
            downloadSelected={submitSelectedOrderDocuments}
          />

          <section className="panel third">
            <div className="section-title">
              <span className="step-dot">1</span>
              <div>
                <h2>订单输入</h2>
                <p className="muted">支持一行一个，也支持用空格、逗号分隔。</p>
              </div>
            </div>
            <div className="field">
              <label>订单/货件编号</label>
              <textarea
                rows={10}
                value={orderNumbersText}
                onChange={(event) => setOrderNumbersText(event.target.value)}
                placeholder={"每行一个，例如 12345678-0001-1"}
              />
            </div>
            <div className="field">
              <label>物流贴单 PDF 地址</label>
              <textarea rows={10} value={orderShippingLabelText} onChange={(event) => setOrderShippingLabelText(event.target.value)} placeholder="每行一个 PDF 地址，顺序与订单一致，不能重复使用" />
            </div>
          </section>

          <section className="panel third">
            <div className="section-title">
              <span className="step-dot">2</span>
              <div>
                <h2>保存位置</h2>
                <p className="muted">会自动记住上一次选择的输出目录。</p>
              </div>
            </div>
            <div className="field">
              <label>输出目录</label>
              <PathInput value={orderOutputRoot} onChange={setOrderOutputRoot} mode="dir" />
            </div>
            <div className="panel-subsection compact">
              <span className="muted">当前目录</span>
              <strong className="path-summary">{orderOutputRoot || "未选择"}</strong>
            </div>
          </section>

          <section className="panel third">
            <div className="section-title">
              <span className="step-dot">3</span>
              <div>
                <h2>后台授权</h2>
                <p className="muted">HAR 和 Cookie 二选一即可，选择结果会自动保存。</p>
              </div>
            </div>
            <div className="field">
              <label>Ozon 后台 HAR</label>
              <PathInput value={ozonSellerHarPath} onChange={setOzonSellerHarPath} mode="file" />
            </div>
            <div className="field">
              <label>Ozon 后台 Cookie</label>
              <textarea
                rows={6}
                value={ozonSellerCookiePath}
                onChange={(event) => setOzonSellerCookiePath(event.target.value)}
                placeholder="可粘贴 Cookie、Cookie: ...、浏览器 Copy as cURL，或填写 Cookie 文本文件路径"
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>货号素材</h2>
                <p className="muted">这是可选功能，默认关闭；开启后需要填写百度网盘 Cookie。</p>
              </div>
              <button className="secondary-button" onClick={() => run(async () => {
                await saveBaiduCookie();
                setFriendlyMessage("百度网盘 Cookie 已保存。");
              })}>保存 Cookie</button>
            </div>
            <div className="form-grid">
              <div className="field">
                <label>百度网盘 Cookie</label>
                <textarea
                  rows={4}
                  value={baiduCookie}
                  onChange={(event) => setBaiduCookie(event.target.value)}
                  placeholder="粘贴百度网盘 Cookie，需包含 BDUSS"
                />
              </div>
              <div className="field">
                <label>网盘搜索目录</label>
                <input value={baiduSearchDir} onChange={(event) => setBaiduSearchDir(event.target.value)} placeholder="/" />
              </div>
            </div>
            <div className="check-grid compact-checks">
              <label className="check-card">
                <input type="checkbox" checked={downloadMaterials} onChange={(event) => setDownloadMaterials(event.target.checked)} />
                下载货号素材
              </label>
              <label className="check-card">
                <input type="checkbox" checked={baiduRecursive} onChange={(event) => setBaiduRecursive(event.target.checked)} />
                递归搜索网盘子目录
              </label>
            </div>
          </section>
        </>
      ) : null}

      {tab === "follow" ? (
        <FollowSyncPanel
          shop={currentShop}
          mainShop={currentMainShop}
          followerShops={followerShops}
          startSync={startFollowSync}
          startAutomation={startFollowAutomation}
          autoFollowSync={followAutoSync}
          setAutoFollowSync={setFollowAutoSync}
          autoUpdateStock={followAutoStock}
          setAutoUpdateStock={setFollowAutoStock}
          autoGenerateBarcode={followAutoBarcode}
          setAutoGenerateBarcode={setFollowAutoBarcode}
          autoAddToAction={followAutoAction}
          setAutoAddToAction={setFollowAutoAction}
          intervalMinutes={followIntervalMinutes}
          setIntervalMinutes={setFollowIntervalMinutes}
          maxFollowItems={followMaxItems}
          setMaxFollowItems={setFollowMaxItems}
          priceMultiplier={followPriceMultiplier}
          setPriceMultiplier={setFollowPriceMultiplier}
          stockValue={stockValue}
          setStockValue={setStockValue}
          actions={actions}
          selectedActionId={selectedActionId}
          setSelectedActionId={setSelectedActionId}
          actionPrice={actionPrice}
          setActionPrice={setActionPrice}
          actionStock={actionStock}
          setActionStock={setActionStock}
          refreshActions={() => run(loadActions)}
          onSettings={() => setShopCenterOpen(false)}
        />
      ) : null}

      {tab === "inventory" ? (
        <>
        <section className="panel task-brief">
          <div>
            <h2>库存价格活动</h2>
            <p className="muted">先在商品列表里查商品、改库存、改价格和生成条码；需要参加活动时再切到活动申报。</p>
          </div>
          <div className="segmented-control">
            <button className={inventoryMode === "products" ? "active" : ""} onClick={() => setInventoryMode("products")}>商品列表</button>
            <button className={inventoryMode === "actions" ? "active" : ""} onClick={() => setInventoryMode("actions")}>活动申报</button>
          </div>
        </section>

        <ListingMaintenancePanel
          shop={currentShop}
          warehouses={warehouses}
          loadWarehouses={() => run(async () => loadWarehouses(shopId))}
          categories={categories}
          loadCategories={() => run(loadCategories)}
          categorySearch={maintenanceCategorySearch}
          setCategorySearch={setMaintenanceCategorySearch}
          actions={actions}
          loadActions={() => run(loadActions)}
          intervalMinutes={maintenanceIntervalMinutes}
          setIntervalMinutes={setMaintenanceIntervalMinutes}
          autoStock={maintenanceAutoStock}
          setAutoStock={setMaintenanceAutoStock}
          autoBarcode={maintenanceAutoBarcode}
          setAutoBarcode={setMaintenanceAutoBarcode}
          autoAction={maintenanceAutoAction}
          setAutoAction={setMaintenanceAutoAction}
          warehouseId={maintenanceWarehouseId}
          setWarehouseId={setMaintenanceWarehouseId}
          stock={maintenanceStock}
          setStock={setMaintenanceStock}
          actionCategoryId={maintenanceActionCategoryId}
          setActionCategoryId={setMaintenanceActionCategoryId}
          actionId={maintenanceActionId}
          setActionId={setMaintenanceActionId}
          actionPrice={maintenanceActionPrice}
          setActionPrice={setMaintenanceActionPrice}
          actionStock={maintenanceActionStock}
          setActionStock={setMaintenanceActionStock}
          actionConfigs={maintenanceActionConfigs}
          addActionConfig={() => run(async () => addMaintenanceActionConfig())}
          removeActionConfig={removeMaintenanceActionConfig}
          saveConfig={saveListingMaintenanceConfig}
          startTask={startListingMaintenance}
        />

        {inventoryMode === "products" ? (
        <>
        <section className="panel">
          <div className="section-title">
            <span className="step-dot">1</span>
            <div>
              <h2>查询商品</h2>
              <p className="muted">默认使用本地缓存分类；需要同步 Ozon 最新分类时再点击刷新类目。</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label>类目搜索</label>
              <input value={categoryKeyword} onChange={(event) => setCategoryKeyword(event.target.value)} placeholder="输入束发带、发饰或类目 ID" />
            </div>
            <div className="field">
              <label>商品分类 ({filteredCategories.length}/{categories.length})</label>
              <select value={selectedCategoryId} onChange={(event) => setSelectedCategoryId(Number(event.target.value))}>
                <option value="">选择分类</option>
                {filteredCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {"　".repeat(category.level)}{category.name} [{category.nodeKind === "type" ? "类型" : "类目"}] 类目:{category.descriptionCategoryId ?? "-"} 类型:{category.typeId ?? "-"}
                  </option>
                ))}
              </select>
              {selectedCategory() ? (
                <span className="muted">当前选中：{selectedCategory()?.name}，类目 {selectedCategory()?.descriptionCategoryId ?? "-"}，类型 {selectedCategory()?.typeId ?? "-"}</span>
              ) : null}
            </div>
            <div className="field">
              <label>返回数量上限</label>
              <input type="number" min={1} max={1000} value={categoryLimit} onChange={(event) => setCategoryLimit(Number(event.target.value))} />
            </div>
          </div>
          <div className="toolbar action-row">
            <button className="secondary-button" onClick={() => run(loadCategories)}>刷新类目</button>
            <button className="primary-button" onClick={() => run(loadCategoryProducts)}>查询商品</button>
            <button className="secondary-button" onClick={loadZeroStock}>拉取零库存</button>
            <button className="secondary-button" onClick={loadNoBarcode}>拉取无条码</button>
            <span className="muted">当前商品列表 {products.length} 个，已勾选 {selectedProductIds.length} 个。</span>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">
            <span className="step-dot">2</span>
            <div>
              <h2>处理商品</h2>
              <p className="muted">上方输入项会用于下面的操作；先确认操作范围是“所选类目全部商品”还是“当前列表”。</p>
            </div>
          </div>
          {inventoryFeedback ? (
            <div className={inventoryFeedback.tone === "error" ? "operation-feedback error" : "operation-feedback"}>
              <strong>{inventoryFeedback.tone === "error" ? "操作失败" : inventoryFeedback.tone === "running" ? "提交中" : "操作成功"}</strong>
              <span>{inventoryFeedback.message}</span>
            </div>
          ) : null}
          <div className="warehouse-query-block">
            <div>
              <strong>仓库查询</strong>
              <span className="muted">补库存前先查询当前店铺仓库，查询结果会同步到下方仓库下拉。</span>
            </div>
            <button className="secondary-button" disabled={!shopId || warehousesLoading} onClick={() => loadWarehouses(shopId)}>
              {warehousesLoading ? "查询中" : "查询仓库"}
            </button>
          </div>
          {warehouseError ? <div className="alert">{warehouseError}</div> : null}
          <div className="table-wrap compact-table">
            <table>
              <thead><tr><th>仓库名称</th><th>ID</th></tr></thead>
              <tbody>
                {warehouses.map((warehouse) => (
                  <tr key={warehouse.warehouseId}><td>{warehouse.name}</td><td>{warehouse.warehouseId}</td></tr>
                ))}
                {warehouses.length === 0 ? <tr><td colSpan={2} className="muted">{warehousesLoading ? "正在查询仓库数据..." : "暂无仓库数据。"}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="form-grid compact-form-grid">
            <div className="field">
              <label>补库存仓库</label>
              <select value={selectedWarehouseId} onChange={(event) => setSelectedWarehouseId(event.target.value ? Number(event.target.value) : "")}>
                <option value="">选择仓库</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.warehouseId} value={warehouse.warehouseId}>{warehouse.name} ({warehouse.warehouseId})</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>补库存数量</label>
              <input type="number" min={1} value={stockValue} onChange={(event) => setStockValue(Number(event.target.value))} />
            </div>
            <div className="field">
              <label>新售价</label>
              <input value={newPrice} onChange={(event) => setNewPrice(event.target.value)} placeholder="例如 999" />
            </div>
            <div className="field">
              <label>划线价</label>
              <input value={newOldPrice} onChange={(event) => setNewOldPrice(event.target.value)} placeholder="可选，例如 1299" />
            </div>
            <div className="field">
              <label>备用币种</label>
              <input value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} placeholder="优先使用商品原币种" />
            </div>
          </div>
          <div className="product-list-header">
            <div>
              <h3>所选类目全部商品</h3>
              <span className="muted">会扫描当前选择类目下的全部商品，不受上方返回数量上限影响。</span>
            </div>
            {selectedCategory() ? <span className="badge neutral">{selectedCategory()?.name}</span> : <span className="badge neutral">未选类目</span>}
          </div>
          <div className="operation-grid">
            <div className="operation-card">
              <strong>全类目更新库存</strong>
              <span>把所选类目全部商品写入上方仓库和库存数量。</span>
              <button className="primary-button" onClick={() => updateSelectedCategoryProducts("stock")}>
                更新类目库存
              </button>
            </div>
            <div className="operation-card">
              <strong>全类目更新价格</strong>
              <span>把所选类目全部商品写入上方新售价和可选划线价。</span>
              <button className="primary-button" onClick={() => updateSelectedCategoryProducts("price")}>
                更新类目价格
              </button>
            </div>
            <div className="operation-card">
              <strong>库存和价格一起更新</strong>
              <span>一次扫描所选类目，先更新库存，再更新价格。</span>
              <button className="primary-button" onClick={() => updateSelectedCategoryProducts("both")}>
                同时更新
              </button>
            </div>
            <div className="operation-card">
              <strong>全类目更新视频</strong>
              <span>把视频链接更新到所选类目下所有商品，不需要 Excel 和图片目录；可同时提交多个店铺独立任务。</span>
              <button className="primary-button" onClick={submitCategoryVideoUpdate}>
                更新类目视频
              </button>
            </div>
          </div>
          <div className="field">
            <label>视频更新店铺 ({categoryVideoShopIds.length}/{enabledShops.length})</label>
            <div className="toolbar">
              <button type="button" className="secondary-button" onClick={() => setCategoryVideoShopIds(enabledShops.map((shop) => shop.id))}>全选店铺</button>
              <button type="button" className="secondary-button" onClick={() => setCategoryVideoShopIds(shopId ? [shopId] : [])}>只选当前店铺</button>
            </div>
            <div className="check-grid compact-checks">
              {enabledShops.map((shop) => (
                <label key={shop.id} className="check-card">
                  <input
                    type="checkbox"
                    checked={categoryVideoShopIds.includes(shop.id)}
                    onChange={(event) => setCategoryVideoShopIds((current) => (
                      event.target.checked
                        ? normalizeShopIds([...current, shop.id])
                        : current.filter((id) => id !== shop.id)
                    ))}
                  />
                  <span>{shop.name}</span>
                </label>
              ))}
              {enabledShops.length === 0 ? <span className="muted">暂无启用店铺。</span> : null}
            </div>
            <span className="muted">每个店铺会创建一个独立任务，互不取消；任务进度到“任务记录”查看。</span>
          </div>
          <div className="field">
            <label>视频链接 (每行一个)</label>
            <textarea rows={3} value={templateVideoLinks} onChange={(event) => setTemplateVideoLinks(event.target.value)} placeholder="https://..." />
          </div>
          <InventoryTable
            products={products}
            selectedProductIds={selectedProductIds}
            setSelectedProductIds={setSelectedProductIds}
            page={productPage}
            setPage={setProductPage}
            pageSize={productPageSize}
            setPageSize={setProductPageSize}
            shopId={shopId}
            warehouseId={selectedWarehouseId}
            stockValue={stockValue}
            newPrice={newPrice}
            newOldPrice={newOldPrice}
            currencyCode={currencyCode}
            setResult={setResult}
            setFeedback={setInventoryFeedback}
          />
        </section>
        </>
        ) : (
        <section className="panel">
          <ActionPanel
            actions={actions}
            selectedActionId={selectedActionId}
            setSelectedActionId={(value) => {
              setSelectedActionId(value);
              setPendingDeleteAllActionId("");
              writeQueryCache(shopId, "selected-action", value);
              applyCachedActionProducts(shopId, value);
            }}
            actionProducts={actionProducts}
            actionCandidates={actionCandidates}
            selectedActionProductIds={selectedActionProductIds}
            setSelectedActionProductIds={setSelectedActionProductIds}
            selectedActionCandidateIds={selectedActionCandidateIds}
            setSelectedActionCandidateIds={setSelectedActionCandidateIds}
            actionProductLimit={actionProductLimit}
            setActionProductLimit={setActionProductLimit}
            actionProductLastId={actionProductLastId}
            nextActionProductLastId={nextActionProductLastId}
            actionCandidateLastId={actionCandidateLastId}
            nextActionCandidateLastId={nextActionCandidateLastId}
            actionPrice={actionPrice}
            setActionPrice={setActionPrice}
            actionStock={actionStock}
            setActionStock={setActionStock}
            selectedProductCount={selectedProductIds.length}
            loadActions={() => run(loadActions)}
            loadActionProducts={(lastId) => run(async () => loadActionProducts(lastId))}
            loadActionCandidates={(lastId) => run(async () => loadActionCandidates(lastId))}
            addSelectedProducts={() => run(addSelectedProductsToAction)}
            removeSelectedProducts={() => run(removeSelectedProductsFromAction)}
            removeAllProducts={() => run(removeAllProductsFromAction)}
            deleteAllPending={pendingDeleteAllActionId === Number(selectedActionId)}
            setResult={setResult}
          />
        </section>
        )}
        </>
      ) : null}

      {tab === "analytics" ? (
        <ProductAnalyticsPanel
          dateFrom={analyticsDateFrom}
          setDateFrom={setAnalyticsDateFrom}
          dateTo={analyticsDateTo}
          setDateTo={setAnalyticsDateTo}
          maxDate={analyticsMaxDate}
          limit={analyticsLimit}
          setLimit={setAnalyticsLimit}
          minimumCardViews={minimumCardViews}
          setMinimumCardViews={(value) => {
            setMinimumCardViews(value);
            setSelectedAnalyticsProductIds([]);
            setMergeConfirmPending(false);
          }}
          products={visibleAnalyticsRows}
          totalProductCount={analyticsRows.length}
          selectedProductIds={selectedAnalyticsProductIds}
          setSelectedProductIds={(value) => {
            setSelectedAnalyticsProductIds(value);
            setMergeConfirmPending(false);
          }}
          loadAnalytics={() => run(loadAnalytics)}
          mergeProducts={() => run(mergeSelectedAnalyticsProducts)}
          mergeConfirmPending={mergeConfirmPending}
        />
      ) : null}

      {tab === "api" ? (
        <>
          <section className="panel half">
            <div className="panel-header">
              <h2>连接测试</h2>
              <button className="primary-button" disabled={!shopId} onClick={() => run(async () => {
                const data = await api.testOzonConnection(shopId);
                setResult(JSON.stringify(data, null, 2));
              })}>测试 Ozon</button>
            </div>
            <LongOutput value={result} emptyText="接口返回和错误会显示在这里。" maxHeight={180} onClear={() => setResult("")} />
          </section>
          <section className="panel half">
            <h2>诊断提示</h2>
            <p className="muted">仓库查询已移动到“库存价格活动”的“处理商品”区域；这里保留 Ozon 连接测试，用于排查 Client ID、API Key 和接口连通性。</p>
          </section>
        </>
      ) : null}

      {tab !== "api" && tab !== "inventory" ? (
        <section className="panel">
          <h2>接口结果</h2>
          <LongOutput value={result} emptyText="任务提交结果和错误会显示在这里。" maxHeight={180} onClear={() => setResult("")} />
        </section>
      ) : null}
      {shopDialogOpen ? (
        <ShopEditorDialog
          shop={editingShop}
          shops={shops}
          onClose={() => setShopDialogOpen(false)}
          onSaved={async (saved) => {
            setShopMessage(`${saved.name} 已保存。`);
            setShopDialogOpen(false);
            setEditingShop(undefined);
            setShopId(saved.id);
            await onChanged();
          }}
          onDeleted={async () => {
            setShopMessage("店铺已删除。");
            setShopDialogOpen(false);
            setEditingShop(undefined);
            setShopCenterOpen(false);
            await onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function TaskNavigation(props: {
  activeTab: TabKey;
  onSelect: (tab: TabKey) => void;
}) {
  return (
    <div className="task-nav shop-function-menu" role="navigation" aria-label="Ozon 任务导航">
      {TASK_TABS.map((item) => (
        <button
          key={item.key}
          className={props.activeTab === item.key ? "task-nav-item active" : "task-nav-item"}
          onClick={() => props.onSelect(item.key)}
        >
          <strong>{item.label}</strong>
        </button>
      ))}
    </div>
  );
}

function ShopMaintenanceHomePanel(props: {
  shop?: Shop;
  shops: Shop[];
  runningJobs: JobSummary[];
  runningJob?: JobSummary;
  canStart: boolean;
  onStart: () => void;
  onPause: () => void;
  onStartAll: () => void;
  onPauseAll: () => void;
}) {
  const running = Boolean(props.runningJob);
  const runnableShopCount = props.shops.filter((shop) => shop.enabled && isListingMaintenanceEnabledForShop(shop)).length;
  return (
    <section className="panel shop-maintenance-command-bar">
      <div className="panel-header">
        <div>
          <h2>定时运维</h2>
          <p className="muted">启动后每 2 小时执行一轮上架后运维任务，完成后自动结束；批量执行会按每个已启用店铺保存的配置启动。</p>
        </div>
        <div className="toolbar">
          <button className="primary-button" disabled={!props.shop || running || !props.canStart} onClick={props.onStart}>启动定时运维</button>
          <button className="secondary-button" disabled={!running} onClick={props.onPause}>暂停定时运维</button>
          <button className="primary-button" disabled={runnableShopCount === 0} onClick={props.onStartAll}>全部店铺执行</button>
          <button className="danger-button" disabled={props.runningJobs.length === 0} onClick={props.onPauseAll}>全部店铺停止</button>
        </div>
      </div>
      <div className="shop-center-summary">
        <div className="shop-summary-item">
          <span>当前店铺</span>
          <strong>{props.shop?.name ?? "未选择"}</strong>
        </div>
        <div className="shop-summary-item">
          <span>可执行店铺</span>
          <strong>{runnableShopCount} 个</strong>
        </div>
        <div className="shop-summary-item">
          <span>运行中</span>
          <strong>{props.runningJobs.length} 个</strong>
        </div>
        <div className="shop-summary-item">
          <span>当前状态</span>
          <strong>{running ? "运行中" : "已暂停"}</strong>
        </div>
      </div>
    </section>
  );
}

function ShopManagementPanel(props: {
  shops: Shop[];
  selectedShopId: string;
  onSelectShop: (id: string) => void;
  onOpenShopCenter: (id: string) => void;
  onCreateShop: () => void;
  onEditShop: (shop: Shop) => void;
}) {
  const pageSize = 10;
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const normalizedKeyword = keyword.trim().toLowerCase();
  const filteredShops = normalizedKeyword
    ? props.shops.filter((shop) => {
      const haystack = [shop.name, shop.clientId, shop.id].join(" ").toLowerCase();
      return haystack.includes(normalizedKeyword);
    })
    : props.shops;
  const totalPages = Math.max(1, Math.ceil(filteredShops.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedShops = filteredShops.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const enabledCount = props.shops.filter((shop) => shop.enabled).length;
  const onlineCount = props.shops.filter((shop) => shop.apiKeyStored).length;
  const watermarkCount = props.shops.filter((shop) => shop.watermarkPath).length;

  useEffect(() => {
    setPage(1);
  }, [normalizedKeyword]);

  useEffect(() => {
    setPage((value) => Math.min(value, totalPages));
  }, [totalPages]);

  return (
    <>
      <section className="panel shop-manager-filter shop-manager-command-bar">
        <div className="panel-header">
          <div>
            <h2>店铺管理</h2>
            <p className="muted">先维护店铺资料，再进入功能中心操作上架、更新、订单文件、库存和活动。</p>
          </div>
          <div className="toolbar">
            <button className="primary-button" onClick={props.onCreateShop}>新增店铺</button>
          </div>
        </div>
        <div className="shop-manager-summary">
          <div>
            <span>店铺总数</span>
            <strong>{props.shops.length}</strong>
          </div>
          <div>
            <span>已启用</span>
            <strong>{enabledCount}</strong>
          </div>
          <div>
            <span>接口在线</span>
            <strong>{onlineCount}</strong>
          </div>
          <div>
            <span>水印已设</span>
            <strong>{watermarkCount}</strong>
          </div>
          <label className="shop-search-field">
            <span>搜索店铺</span>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="店铺名、账号或 ID" />
          </label>
        </div>
      </section>

      <section className="panel shop-card-panel">
        <div className="shop-card-panel-head">
          <div>
            <h3>店铺列表</h3>
            <span className="muted">当前显示 {filteredShops.length} / {props.shops.length} 个，每页 10 个。</span>
          </div>
          {keyword ? <button className="secondary-button" onClick={() => setKeyword("")}>清空搜索</button> : null}
        </div>
        <div className="shop-table-wrap">
          {pagedShops.length > 0 ? (
            <table className="shop-table">
              <thead>
                <tr>
                  <th>店铺</th>
                  <th>账号</th>
                  <th>类型</th>
                  <th>商品水印</th>
                  <th>账号状态</th>
                  <th>店铺状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedShops.map((shop) => (
                  <tr key={shop.id} className={shop.id === props.selectedShopId ? "active" : ""} onClick={() => props.onSelectShop(shop.id)}>
                    <td>
                      <div className="shop-table-main">
                        <span className="shop-avatar">{shop.name.slice(0, 1).toUpperCase()}</span>
                        <div>
                          <strong>{shop.name}</strong>
                          <span>ID: {shop.id}</span>
                        </div>
                      </div>
                    </td>
                    <td>{shop.clientId}</td>
                    <td>{(shop.shopRole ?? "main") === "follower" ? "跟卖店铺" : "主店"}</td>
                    <td><strong className={shop.watermarkPath ? "green-text" : "red-text"}>{shop.watermarkPath ? "已设置" : "未设置"}</strong></td>
                    <td><strong className={shop.apiKeyStored ? "green-text" : "red-text"}>{shop.apiKeyStored ? "在线" : "离线"}</strong></td>
                    <td><strong className={shop.enabled ? "green-text" : "red-text"}>{shop.enabled ? "启用" : "停用"}</strong></td>
                    <td>
                      <div className="shop-table-actions">
                        <button className="primary-button" onClick={(event) => {
                          event.stopPropagation();
                          props.onOpenShopCenter(shop.id);
                        }}>功能中心</button>
                        <button className="secondary-button" onClick={(event) => {
                          event.stopPropagation();
                          props.onEditShop(shop);
                        }}>编辑</button>
                        <button className="secondary-button" onClick={(event) => {
                          event.stopPropagation();
                          props.onOpenShopCenter(shop.id);
                        }}>上架商品</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {props.shops.length === 0 ? (
            <div className="empty-shop-state">
              <h3>暂无店铺</h3>
              <p className="muted">先新增店铺并保存 Ozon API Key，再从这里进入每个店铺的功能中心。</p>
              <button className="primary-button" onClick={props.onCreateShop}>新增店铺</button>
            </div>
          ) : null}
          {props.shops.length > 0 && filteredShops.length === 0 ? (
            <div className="empty-shop-state">
              <h3>没有匹配店铺</h3>
              <p className="muted">换一个店铺名、账号或 ID 再搜索。</p>
              <button className="secondary-button" onClick={() => setKeyword("")}>清空搜索</button>
            </div>
          ) : null}
        </div>
        {filteredShops.length > pageSize ? (
          <div className="pagination-bar shop-pagination">
            <span>第 {currentPage} / {totalPages} 页</span>
            <button className="secondary-button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            <button className="secondary-button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function CommonUploadFields(props: {
  portraitRoot: string;
  setPortraitRoot: (value: string) => void;
  excelPath: string;
  setExcelPath: (value: string) => void;
  maxItems: number;
  setMaxItems: (value: number) => void;
  templateVideoLinks: string;
  setTemplateVideoLinks: (value: string) => void;
}) {
  return (
    <div className="form-grid">
      <div className="field">
        <label>3:4 图片目录</label>
        <PathInput value={props.portraitRoot} onChange={props.setPortraitRoot} placeholder="选择图片目录" />
      </div>
      <div className="field">
        <label>Excel 路径</label>
        <PathInput value={props.excelPath} onChange={props.setExcelPath} mode="file" placeholder="选择上传 Excel" />
      </div>
      <div className="field">
        <label>最大条目</label>
        <input type="number" min={1} max={10000} value={props.maxItems} onChange={(event) => props.setMaxItems(Number(event.target.value))} />
      </div>
      <div className="field">
        <label>视频链接 (每行一个)</label>
        <textarea rows={3} value={props.templateVideoLinks} onChange={(event) => props.setTemplateVideoLinks(event.target.value)} />
      </div>
    </div>
  );
}

function AutoUploadPostProcessPanel(props: {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  warehouses: WarehouseOption[];
  selectedWarehouseId: number | "";
  setSelectedWarehouseId: (value: number | "") => void;
  stockValue: number;
  setStockValue: (value: number) => void;
  actions: ActionRow[];
  selectedActionId: number | "";
  setSelectedActionId: (value: number | "") => void;
  actionPrice: string;
  setActionPrice: (value: string) => void;
  actionStock: number;
  setActionStock: (value: number) => void;
  refreshWarehouses: () => void;
  refreshActions: () => void;
}) {
  return (
    <div className="panel-subsection">
      <div className="panel-header">
        <div>
          <h3>上架后自动处理</h3>
          <p className="muted">仅用于旧的 Excel 上架流程。云图库自动上架只提交商品到 Ozon，库存、条码和活动请使用下方“上架后自动运维”。</p>
        </div>
        <label className="check-card">
          <input type="checkbox" checked={props.enabled} onChange={(event) => props.setEnabled(event.target.checked)} />
          启用三项自动处理
        </label>
      </div>
      {props.enabled ? (
        <>
          <div className="form-grid compact-form-grid">
            <div className="field">
              <label>库存仓库</label>
              <select value={props.selectedWarehouseId} onChange={(event) => props.setSelectedWarehouseId(event.target.value ? Number(event.target.value) : "")}>
                <option value="">选择仓库</option>
                {props.warehouses.map((warehouse) => (
                  <option key={warehouse.warehouseId} value={warehouse.warehouseId}>{warehouse.name} ({warehouse.warehouseId})</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>自动库存数量</label>
              <input type="number" min={0} value={props.stockValue} onChange={(event) => props.setStockValue(Number(event.target.value))} />
            </div>
            <div className="field">
              <label>促销活动</label>
              <select value={props.selectedActionId} onChange={(event) => props.setSelectedActionId(event.target.value ? Number(event.target.value) : "")}>
                <option value="">选择活动</option>
                {props.actions.map((action) => (
                  <option key={action.id} value={action.id}>{action.title} ({action.id})</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>统一活动价</label>
              <input value={props.actionPrice} onChange={(event) => props.setActionPrice(event.target.value)} placeholder="可留空，优先采用活动建议价" />
            </div>
            <div className="field">
              <label>活动库存</label>
              <input type="number" min={1} value={props.actionStock} onChange={(event) => props.setActionStock(Number(event.target.value))} />
            </div>
          </div>
          <div className="toolbar action-row">
            <button className="secondary-button" type="button" onClick={props.refreshWarehouses}>查询仓库</button>
            <button className="secondary-button" type="button" onClick={props.refreshActions}>刷新活动</button>
            <span className="muted">自动处理失败会写入任务日志和结果表，不会中断后续商品上架。</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

function OrderPostingPanel(props: {
  dateFrom: string;
  setDateFrom: (value: string) => void;
  dateTo: string;
  setDateTo: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  limit: number;
  setLimit: (value: number) => void;
  rows: OrderPostingRow[];
  selectedPostingNumbers: string[];
  setSelectedPostingNumbers: (value: string[]) => void;
  loadOrders: () => void;
  applySelected: () => void;
  downloadSelected: () => void;
}) {
  const postingNumbers = props.rows.map((row) => row.postingNumber).filter(Boolean);
  const selectedSet = new Set(props.selectedPostingNumbers);
  const togglePosting = (postingNumber: string, checked: boolean) => {
    props.setSelectedPostingNumbers(checked
      ? Array.from(new Set([...props.selectedPostingNumbers, postingNumber]))
      : props.selectedPostingNumbers.filter((value) => value !== postingNumber));
  };
  const toggleAll = (checked: boolean) => {
    props.setSelectedPostingNumbers(checked ? postingNumbers : []);
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>获取店铺订单</h2>
          <p className="muted">按日期获取 Ozon FBS 订单/货件，勾选后复用下方订单文件下载流程。</p>
        </div>
        <div className="toolbar">
          <button className="secondary-button" onClick={props.loadOrders}>获取订单</button>
          <button className="secondary-button" disabled={props.selectedPostingNumbers.length === 0} onClick={props.applySelected}>
            写入输入 ({props.selectedPostingNumbers.length})
          </button>
          <button className="primary-button" disabled={props.selectedPostingNumbers.length === 0} onClick={props.downloadSelected}>
            下载勾选 ({props.selectedPostingNumbers.length})
          </button>
        </div>
      </div>
      <div className="form-grid compact-form-grid">
        <div className="field">
          <label>开始日期</label>
          <input type="date" value={props.dateFrom} onChange={(event) => props.setDateFrom(event.target.value)} />
        </div>
        <div className="field">
          <label>结束日期</label>
          <input type="date" value={props.dateTo} onChange={(event) => props.setDateTo(event.target.value)} />
        </div>
        <div className="field">
          <label>订单状态</label>
          <select value={props.status} onChange={(event) => props.setStatus(event.target.value)}>
            <option value="">全部状态</option>
            <option value="awaiting_packaging">待打包</option>
            <option value="awaiting_deliver">待发货</option>
            <option value="delivering">配送中</option>
            <option value="delivered">已签收</option>
            <option value="cancelled">已取消</option>
          </select>
        </div>
        <div className="field">
          <label>最多返回</label>
          <input type="number" min={1} max={1000} value={props.limit} onChange={(event) => props.setLimit(Number(event.target.value))} />
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={postingNumbers.length > 0 && postingNumbers.every((postingNumber) => selectedSet.has(postingNumber))}
                  onChange={(event) => toggleAll(event.target.checked)}
                />
              </th>
              <th>货件编号</th>
              <th>订单号</th>
              <th>状态</th>
              <th>商品</th>
              <th>处理时间</th>
              <th>发货时间</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.postingNumber}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(row.postingNumber)}
                    onChange={(event) => togglePosting(row.postingNumber, event.target.checked)}
                  />
                </td>
                <td>{row.postingNumber}</td>
                <td>{row.orderNumber || row.orderId || "-"}</td>
                <td>{row.status || "-"}</td>
                <td>
                  <div>{row.productsCount} 件</div>
                  <div className="muted">{row.offerIds.slice(0, 4).join("，") || "-"}</div>
                </td>
                <td>{formatDateTime(row.inProcessAt)}</td>
                <td>{formatDateTime(row.shipmentDate)}</td>
              </tr>
            ))}
            {props.rows.length === 0 ? <tr><td colSpan={7} className="muted">点击“获取订单”加载店铺订单。</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ListingMaintenancePanel(props: {
  shop: Shop | undefined;
  warehouses: WarehouseOption[];
  loadWarehouses: () => void;
  categories: CategoryOption[];
  loadCategories: () => void;
  categorySearch: string;
  setCategorySearch: (value: string) => void;
  actions: ActionRow[];
  loadActions: () => void;
  intervalMinutes: number;
  setIntervalMinutes: (value: number) => void;
  autoStock: boolean;
  setAutoStock: (value: boolean) => void;
  autoBarcode: boolean;
  setAutoBarcode: (value: boolean) => void;
  autoAction: boolean;
  setAutoAction: (value: boolean) => void;
  warehouseId: number | "";
  setWarehouseId: (value: number | "") => void;
  stock: number;
  setStock: (value: number) => void;
  actionCategoryId: number | "";
  setActionCategoryId: (value: number | "") => void;
  actionId: number | "";
  setActionId: (value: number | "") => void;
  actionPrice: string;
  setActionPrice: (value: string) => void;
  actionStock: number;
  setActionStock: (value: number) => void;
  actionConfigs: ListingMaintenanceActionConfig[];
  addActionConfig: () => void;
  removeActionConfig: (categoryId: number, actionId: number) => void;
  saveConfig: () => void;
  startTask: () => void;
}) {
  const enabled = props.autoStock || props.autoBarcode || (props.autoAction && props.actionConfigs.length > 0);
  const categoryKeyword = props.categorySearch.trim().toLowerCase();
  const visibleCategories = categoryKeyword
    ? props.categories.filter((category) => (
      `${category.name} ${category.id} ${category.descriptionCategoryId ?? ""} ${category.typeId ?? ""}`
        .toLowerCase()
        .includes(categoryKeyword)
    ))
    : props.categories;
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>上架后自动运维</h2>
          <p className="muted">自动上架只提交商品到 Ozon；库存、条码和活动在这里按店铺配置，每 2 小时独立检查并处理，单轮完成后自动结束。</p>
        </div>
        <div className="toolbar">
          <button className="secondary-button" disabled={!props.shop} onClick={props.saveConfig}>保存配置</button>
          <button className="primary-button" disabled={!props.shop || !enabled} onClick={props.startTask}>启动定时运维</button>
        </div>
      </div>
      <div className="check-grid compact-checks">
        <label className="check-card">
          <input type="checkbox" checked={props.autoStock} onChange={(event) => props.setAutoStock(event.target.checked)} />
          自动补零库存
        </label>
        <label className="check-card">
          <input type="checkbox" checked={props.autoBarcode} onChange={(event) => props.setAutoBarcode(event.target.checked)} />
          自动生成条码
        </label>
        <label className="check-card">
          <input type="checkbox" checked={props.autoAction} onChange={(event) => props.setAutoAction(event.target.checked)} />
          按类目规则管控活动
        </label>
      </div>
      <div className="form-grid compact-form-grid">
        <div className="field">
          <label>执行间隔（分钟）</label>
          <input type="number" min={120} max={120} value={LISTING_MAINTENANCE_INTERVAL_MINUTES} disabled onChange={(event) => props.setIntervalMinutes(Number(event.target.value))} />
        </div>
        <div className="field">
          <label>补库存仓库</label>
          <select value={props.warehouseId} onChange={(event) => props.setWarehouseId(event.target.value ? Number(event.target.value) : "")}>
            <option value="">未选择，单仓库时自动使用</option>
            {props.warehouses.map((warehouse) => (
              <option key={warehouse.warehouseId} value={warehouse.warehouseId}>{warehouse.name} ({warehouse.warehouseId})</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>补库存数量</label>
          <input type="number" min={0} value={props.stock} onChange={(event) => props.setStock(Number(event.target.value))} />
        </div>
        <div className="field">
          <label>基础数据</label>
          <div className="toolbar">
            <button className="secondary-button" disabled={!props.shop} onClick={props.loadWarehouses}>刷新仓库</button>
            <button className="secondary-button" disabled={!props.shop} onClick={props.loadCategories}>刷新类目</button>
            <button className="secondary-button" disabled={!props.shop} onClick={props.loadActions}>加载活动</button>
          </div>
        </div>
      </div>
      <div className="panel-subsection">
        <div className="section-title">
          <span className="step-dot">A</span>
          <div>
            <h3>类目活动规则</h3>
            <p className="muted">开启活动管控后，仅保留本规则中的活动商品；Ozon 自动加入的其他活动会自动移除商品。</p>
          </div>
        </div>
        <div className="form-grid compact-form-grid">
          <div className="field">
            <label>类目搜索</label>
            <input
              value={props.categorySearch}
              onChange={(event) => props.setCategorySearch(event.target.value)}
              placeholder="输入类目名称或 ID"
            />
          </div>
          <div className="field">
            <label>商品类目（{visibleCategories.length}/{props.categories.length}）</label>
            <select value={props.actionCategoryId} onChange={(event) => props.setActionCategoryId(event.target.value ? Number(event.target.value) : "")}>
              <option value="">选择类目</option>
              {visibleCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name} ({category.descriptionCategoryId ?? category.id})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>活动</label>
            <select value={props.actionId} onChange={(event) => props.setActionId(event.target.value ? Number(event.target.value) : "")}>
              <option value="">选择活动</option>
              {props.actions.map((action) => (
                <option key={action.id} value={action.id}>{action.title} ({action.id})</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>活动价格</label>
            <input value={props.actionPrice} onChange={(event) => props.setActionPrice(event.target.value)} />
          </div>
          <div className="field">
            <label>活动库存</label>
            <input type="number" min={1} value={props.actionStock} onChange={(event) => props.setActionStock(Number(event.target.value))} />
          </div>
          <div className="field">
            <label>规则操作</label>
            <button className="secondary-button" type="button" onClick={props.addActionConfig}>添加/更新规则</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>类目</th><th>活动</th><th>活动价格</th><th>活动库存</th><th>操作</th></tr></thead>
            <tbody>
              {props.actionConfigs.map((config) => (
                <tr key={`${config.categoryId}:${config.actionId}`}>
                  <td>{config.categoryName || config.categoryId}</td>
                  <td>{config.actionTitle || config.actionId}</td>
                  <td>{config.actionPrice}</td>
                  <td>{config.actionStock}</td>
                  <td><button className="secondary-button" onClick={() => props.removeActionConfig(config.categoryId, config.actionId)}>删除</button></td>
                </tr>
              ))}
              {props.actionConfigs.length === 0 ? (
                <tr><td colSpan={5} className="muted">还没有配置类目活动规则。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function FollowSyncPanel(props: {
  shop: Shop | undefined;
  mainShop: Shop | undefined;
  followerShops: Shop[];
  startSync: () => void;
  startAutomation: () => void;
  autoFollowSync: boolean;
  setAutoFollowSync: (value: boolean) => void;
  autoUpdateStock: boolean;
  setAutoUpdateStock: (value: boolean) => void;
  autoGenerateBarcode: boolean;
  setAutoGenerateBarcode: (value: boolean) => void;
  autoAddToAction: boolean;
  setAutoAddToAction: (value: boolean) => void;
  intervalMinutes: number;
  setIntervalMinutes: (value: number) => void;
  maxFollowItems: number;
  setMaxFollowItems: (value: number) => void;
  priceMultiplier: number;
  setPriceMultiplier: (value: number) => void;
  stockValue: number;
  setStockValue: (value: number) => void;
  actions: ActionRow[];
  selectedActionId: number | "";
  setSelectedActionId: (value: number | "") => void;
  actionPrice: string;
  setActionPrice: (value: string) => void;
  actionStock: number;
  setActionStock: (value: number) => void;
  refreshActions: () => void;
  onSettings: () => void;
}) {
  const isFollower = (props.shop?.shopRole ?? "main") === "follower";
  const canSync = Boolean(props.shop) && (isFollower ? Boolean(props.mainShop) : props.followerShops.length > 0);
  const targetFollowerShops = isFollower && props.shop ? [props.shop] : props.followerShops;
  const unsavedWarehouseShops = targetFollowerShops.filter((shop) => !shop.followWarehouseId);
  const hasAutomationTask = props.autoFollowSync || props.autoUpdateStock || props.autoGenerateBarcode || props.autoAddToAction;
  return (
    <>
      <section className="panel task-brief">
        <div>
          <h2>跟卖商品同步</h2>
          <p className="muted">同步会补齐跟卖店缺失的主店商品，同货号已存在时跳过，跟卖售价按选择的倍数计算。</p>
        </div>
        <div className="toolbar">
          <div className="field follow-price-field">
            <label>加价倍数</label>
            <input
              type="number"
              min={2}
              max={10}
              step={0.1}
              value={props.priceMultiplier}
              onChange={(event) => props.setPriceMultiplier(Number(event.target.value))}
            />
          </div>
          <button className="primary-button" disabled={!canSync} onClick={props.startSync}>开始同步</button>
          <button className="secondary-button" onClick={props.onSettings}>配置店铺关系</button>
        </div>
      </section>
      <section className="panel">
        <div className="overview-status-grid">
          <div className="status-block">
            <span>当前店铺</span>
            <strong>{props.shop?.name || "未选择"}</strong>
            <em>{isFollower ? "跟卖店铺" : "主店"}</em>
          </div>
          <div className="status-block">
            <span>主店</span>
            <strong>{isFollower ? props.mainShop?.name || "未选择" : props.shop?.name || "-"}</strong>
            <em>{isFollower ? "当前跟卖来源" : "当前同步来源"}</em>
          </div>
          <div className="status-block">
            <span>跟卖店铺</span>
            <strong>{isFollower ? props.shop?.name || "-" : `${props.followerShops.length} 个`}</strong>
            <em>{isFollower ? "仅同步当前店铺" : "同步到这些跟卖店铺"}</em>
          </div>
          <div className="status-block">
            <span>跟卖仓库</span>
            <strong>{unsavedWarehouseShops.length === 0 && targetFollowerShops.length > 0 ? "已保存" : `${unsavedWarehouseShops.length} 未保存`}</strong>
            <em>后台唯一仓库会自动使用</em>
          </div>
          <div className="status-block">
            <span>价格倍率</span>
            <strong>{props.priceMultiplier} 倍</strong>
            <em>按主店售价计算</em>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>跟卖自动化</h2>
            <p className="muted">按固定间隔循环执行勾选任务；上架达到本轮上限时，只停止跟卖上架，补库存、条形码和活动继续执行。</p>
          </div>
          <div className="toolbar">
            <button className="primary-button" disabled={!canSync || !hasAutomationTask} onClick={props.startAutomation}>启动自动化</button>
            <button className="secondary-button" onClick={props.refreshActions}>刷新活动</button>
          </div>
        </div>
        <div className="check-grid compact-checks">
          <label className="check-card">
            <input type="checkbox" checked={props.autoFollowSync} onChange={(event) => props.setAutoFollowSync(event.target.checked)} />
            自动跟卖主店铺
          </label>
          <label className="check-card">
            <input type="checkbox" checked={props.autoUpdateStock} onChange={(event) => props.setAutoUpdateStock(event.target.checked)} />
            自动给零库存补库存
          </label>
          <label className="check-card">
            <input type="checkbox" checked={props.autoGenerateBarcode} onChange={(event) => props.setAutoGenerateBarcode(event.target.checked)} />
            自动给无条码商品加条形码
          </label>
          <label className="check-card">
            <input type="checkbox" checked={props.autoAddToAction} onChange={(event) => props.setAutoAddToAction(event.target.checked)} />
            按类目规则管控活动
          </label>
        </div>
        <div className="form-grid compact-form-grid">
          <div className="field">
            <label>定时间隔 (分钟)</label>
            <input type="number" min={1} max={1440} value={props.intervalMinutes} onChange={(event) => props.setIntervalMinutes(Number(event.target.value))} />
          </div>
          <div className="field">
            <label>自动跟卖上架总上限</label>
            <input type="number" min={0} value={props.maxFollowItems} onChange={(event) => props.setMaxFollowItems(Number(event.target.value))} />
          </div>
          <div className="field">
            <label>自动跟卖加价倍数</label>
            <input
              type="number"
              min={2}
              max={10}
              step={0.1}
              value={props.priceMultiplier}
              onChange={(event) => props.setPriceMultiplier(Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>补库存数量</label>
            <input type="number" min={0} value={props.stockValue} onChange={(event) => props.setStockValue(Number(event.target.value))} />
          </div>
          <div className="field">
            <label>活动</label>
            <select value={props.selectedActionId} onChange={(event) => props.setSelectedActionId(event.target.value ? Number(event.target.value) : "")}>
              <option value="">选择活动</option>
              {props.actions.map((action) => (
                <option key={action.id} value={action.id}>{action.title} ({action.id})</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>统一活动价</label>
            <input value={props.actionPrice} onChange={(event) => props.setActionPrice(event.target.value)} placeholder="可留空，优先使用活动建议价" />
          </div>
          <div className="field">
            <label>活动库存</label>
            <input type="number" min={1} value={props.actionStock} onChange={(event) => props.setActionStock(Number(event.target.value))} />
          </div>
        </div>
        {props.autoUpdateStock && unsavedWarehouseShops.length > 0 ? (
          <div className="feedback-panel">
            <strong>仓库未保存</strong>
            <span>{unsavedWarehouseShops.map((shop) => shop.name).join("、")}：如果 Ozon 后台实际只有一个仓库，会自动使用；多个仓库时请在编辑店铺中填写唯一仓库 ID。</span>
          </div>
        ) : null}
      </section>
      {!isFollower && props.followerShops.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <h2>跟卖店铺列表</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>店铺</th><th>Client-Id</th><th>仓库</th><th>状态</th><th>水印</th></tr></thead>
              <tbody>
                {props.followerShops.map((shop) => (
                  <tr key={shop.id}>
                    <td>{shop.name}</td>
                    <td>{shop.clientId}</td>
                    <td>{shop.followWarehouseId ?? "未设置"}</td>
                    <td>{shop.enabled ? "启用" : "停用"}</td>
                    <td>{shop.watermarkPath ? "已设置" : "未设置"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {!canSync ? (
        <section className="panel feedback-panel error">
          <strong>无法同步</strong>
          <span>{isFollower ? "当前跟卖店铺还没有选择主店。" : "当前主店下还没有配置跟卖店铺。"}</span>
        </section>
      ) : null}
    </>
  );
}

function ProductAnalyticsPanel(props: {
  dateFrom: string;
  setDateFrom: (value: string) => void;
  dateTo: string;
  setDateTo: (value: string) => void;
  maxDate: string;
  limit: number;
  setLimit: (value: number) => void;
  minimumCardViews: number;
  setMinimumCardViews: (value: number) => void;
  products: ProductAnalyticsRow[];
  totalProductCount: number;
  selectedProductIds: number[];
  setSelectedProductIds: (value: number[]) => void;
  loadAnalytics: () => void;
  mergeProducts: () => void;
  mergeConfirmPending: boolean;
}) {
  const productIds = props.products
    .map((product) => product.productId)
    .filter((productId): productId is number => typeof productId === "number");
  const selectedSet = new Set(props.selectedProductIds);
  const toggleProduct = (productId: number, checked: boolean) => {
    props.setSelectedProductIds(checked
      ? Array.from(new Set([...props.selectedProductIds, productId]))
      : props.selectedProductIds.filter((id) => id !== productId));
  };
  const toggleAll = (checked: boolean) => {
    props.setSelectedProductIds(checked ? productIds : []);
  };

  const selectedProducts = props.products.filter((product) => product.productId && selectedSet.has(product.productId));
  const categoryCounts = new Map<string, number>();
  for (const product of selectedProducts) {
    const key = `${product.categoryId ?? "unknown"}:${product.typeId ?? "unknown"}`;
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
  }
  const expectedGroups = Array.from(categoryCounts.values())
    .reduce((total, count) => total + (count >= 2 ? Math.ceil(count / 20) : 0), 0);

  return (
    <>
      <section className="panel task-brief">
        <div>
          <h2>商品浏览量与合并商品卡</h2>
          <p className="muted">按商品详情页浏览量降序查看。合并时只处理勾选商品，并严格按“类目 + 类型”分组，每组最多 20 个。</p>
        </div>
        <div className="toolbar">
          <button className="primary-button" onClick={props.loadAnalytics}>查询浏览量</button>
          <button className={props.mergeConfirmPending ? "danger-button" : "secondary-button"} disabled={props.selectedProductIds.length < 2} onClick={props.mergeProducts}>
            {props.mergeConfirmPending ? "确认合并商品卡" : `合并所选商品 (${props.selectedProductIds.length})`}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="form-grid compact-form-grid">
          <div className="field">
            <label>开始日期</label>
            <input type="date" max={props.maxDate} value={props.dateFrom} onChange={(event) => props.setDateFrom(event.target.value)} />
          </div>
          <div className="field">
            <label>结束日期</label>
            <input type="date" max={props.maxDate} value={props.dateTo} onChange={(event) => props.setDateTo(event.target.value)} />
            <span className="muted">Ozon 当前可查询至 {props.maxDate}（UTC）</span>
          </div>
          <div className="field">
            <label>最多返回商品数</label>
            <input type="number" min={1} max={1000} value={props.limit} onChange={(event) => props.setLimit(Number(event.target.value))} />
          </div>
          <div className="field">
            <label>最低详情页浏览量</label>
            <input type="number" min={0} value={props.minimumCardViews} onChange={(event) => props.setMinimumCardViews(Number(event.target.value))} />
          </div>
        </div>
        <div className="toolbar action-row">
          <span className="muted">接口返回 {props.totalProductCount} 个，当前筛选 {props.products.length} 个；所选预计形成 {expectedGroups} 组。</span>
        </div>
      </section>

      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={productIds.length > 0 && productIds.every((productId) => selectedSet.has(productId))}
                    onChange={(event) => toggleAll(event.target.checked)}
                  />
                </th>
                <th>排名</th>
                <th>商品</th>
                <th>类目 / 类型</th>
                <th>详情页浏览量</th>
                <th>搜索曝光浏览量</th>
              </tr>
            </thead>
            <tbody>
              {props.products.map((product, index) => (
                <tr key={product.productId ?? product.offerId}>
                  <td>
                    {product.productId ? (
                      <input
                        type="checkbox"
                        checked={selectedSet.has(product.productId)}
                        onChange={(event) => toggleProduct(product.productId!, event.target.checked)}
                      />
                    ) : null}
                  </td>
                  <td>{index + 1}</td>
                  <td>
                    <button
                      className="product-title-link"
                      type="button"
                      onClick={() => product.productId && api.openUrl(`https://www.ozon.ru/product/${product.productId}/`)}
                    >
                      {product.name || product.offerId || product.productId}
                    </button>
                    <div className="muted">货号: {product.offerId || "-"} · 商品 ID: {product.productId ?? "-"}</div>
                  </td>
                  <td>
                    <div>{product.categoryName || product.categoryId || "-"}</div>
                    <div className="muted">{product.typeName || product.typeId || "-"}</div>
                  </td>
                  <td><strong>{product.cardViews}</strong></td>
                  <td>{product.searchViews}</td>
                </tr>
              ))}
              {props.products.length === 0 ? (
                <tr><td colSpan={6} className="muted">点击“查询浏览量”加载数据，或调低最低浏览量。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ProductTemplatePanel(props: {
  shopId: string;
  templates: TemplateSummary[];
  selectedTemplateId: string;
  selectTemplate: (id: string) => void;
  templateName: string;
  setTemplateName: (value: string) => void;
  templateOfferId: string;
  setTemplateOfferId: (value: string) => void;
  templateJson: string;
  setTemplateJson: (value: string) => void;
  templateStatus: string;
  templateProduct: unknown | undefined;
  fetchOnlineTemplate: () => void;
  applyJsonTemplate: () => void;
  saveCurrentTemplate: () => void;
  deleteCurrentTemplate: () => void;
  clearTemplate: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>商品模板</h2>
          <p className="muted">模板保留类目、尺寸、价格、属性等结构；Excel 会覆盖货号、标题、简介和图片。</p>
        </div>
        <span className={props.templateProduct ? "badge" : "badge warn"}>{props.templateStatus}</span>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>已保存模板</label>
          <select value={props.selectedTemplateId} onChange={(event) => props.selectTemplate(event.target.value)}>
            <option value="">选择保存模板</option>
            {props.templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>模板名称</label>
          <input value={props.templateName} onChange={(event) => props.setTemplateName(event.target.value)} placeholder="例如：方巾通用模板" />
        </div>
        <div className="field">
          <label>线上模板货号</label>
          <input value={props.templateOfferId} onChange={(event) => props.setTemplateOfferId(event.target.value)} placeholder="输入 Ozon 货号 offer_id" />
        </div>
        <div className="field">
          <label>模板操作</label>
          <div className="toolbar">
            <button className="secondary-button" disabled={!props.shopId} onClick={props.fetchOnlineTemplate}>读取线上模板</button>
            <button className="secondary-button" onClick={props.saveCurrentTemplate}>保存模板</button>
            <button className="secondary-button" disabled={!props.selectedTemplateId} onClick={props.deleteCurrentTemplate}>删除模板</button>
            <button className="danger-button" onClick={props.clearTemplate}>清空</button>
          </div>
        </div>
        <div className="field full">
          <label>JSON 模板</label>
          <textarea rows={7} value={props.templateJson} onChange={(event) => props.setTemplateJson(event.target.value)} placeholder="可粘贴 Ozon 商品详情 JSON 或旧工具模板 JSON" />
          <div className="toolbar">
            <button className="secondary-button" onClick={props.applyJsonTemplate}>应用粘贴 JSON</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ShopEditorDialog(props: {
  shop?: Shop;
  shops: Shop[];
  onClose: () => void;
  onSaved: (shop: Shop) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ShopDraft>(() => shopToDraft(props.shop));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const saved = await api.saveShop(draft);
      await props.onSaved(saved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!props.shop) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setMessage("再次点击删除店铺确认操作。");
      return;
    }
    setDeleting(true);
    setMessage("");
    try {
      await api.deleteShop(props.shop.id);
      await props.onDeleted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={props.onClose}>
      <section className="modal-panel shop-editor-dialog" role="dialog" aria-modal="true" aria-label={props.shop ? "编辑店铺" : "新增店铺"} onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <div>
            <h2>{props.shop ? "编辑店铺" : "新增店铺"}</h2>
            <p className="muted">保存后可直接在店铺管理里进入功能中心。</p>
          </div>
          <button className="icon-button" onClick={props.onClose} title="关闭">×</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>店铺名称</label>
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </div>
          <div className="field">
            <label>Client-Id</label>
            <input value={draft.clientId} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })} />
          </div>
          <div className="field">
            <label>Ozon API Key</label>
            <input type="password" value={draft.apiKey ?? ""} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={props.shop?.apiKeyStored ? "已保存，不填则沿用" : ""} />
          </div>
          <div className="field">
            <label>店铺类型</label>
            <select value={draft.shopRole ?? "main"} onChange={(event) => setDraft({
              ...draft,
              shopRole: event.target.value as "main" | "follower",
              followsShopId: event.target.value === "main" ? "" : draft.followsShopId,
              followWarehouseId: event.target.value === "main" ? undefined : draft.followWarehouseId,
            })}>
              <option value="main">主店</option>
              <option value="follower">跟卖店铺</option>
            </select>
          </div>
          {(draft.shopRole ?? "main") === "follower" ? (
            <>
              <div className="field">
                <label>跟卖主店</label>
                <select value={draft.followsShopId ?? ""} onChange={(event) => setDraft({ ...draft, followsShopId: event.target.value })}>
                  <option value="">选择主店</option>
                  {props.shops
                    .filter((shop) => shop.id !== props.shop?.id && (shop.shopRole ?? "main") === "main")
                    .map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>跟卖仓库 ID</label>
                <input
                  type="number"
                  value={draft.followWarehouseId ?? ""}
                  onChange={(event) => setDraft({ ...draft, followWarehouseId: event.target.value ? Number(event.target.value) : undefined })}
                />
              </div>
            </>
          ) : null}
          <div className="field">
            <label>店铺水印图片</label>
            <PathInput value={draft.watermarkPath ?? ""} onChange={(value) => setDraft({ ...draft, watermarkPath: value })} mode="file" />
          </div>
        </div>
        <div className="check-grid compact-checks">
          <label className="check-card">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            启用店铺
          </label>
        </div>
        {message ? <p className="error-text">{message}</p> : null}
        <div className="modal-actions">
          {props.shop ? <button className="danger-button" onClick={remove} disabled={saving || deleting}>{confirmDelete ? "确认删除" : "删除店铺"}</button> : null}
          <button className="secondary-button" onClick={props.onClose}>取消</button>
          <button className="primary-button" onClick={save} disabled={saving || deleting}>{saving ? "保存中" : "保存店铺"}</button>
        </div>
      </section>
    </div>
  );
}

function shopToDraft(shop?: Shop): ShopDraft {
  return {
    id: shop?.id,
    name: shop?.name ?? "",
    clientId: shop?.clientId ?? "",
    apiKey: "",
    ossAccessKeyId: shop?.ossAccessKeyId ?? "",
    ossAccessKeySecret: "",
    ossBucket: shop?.ossBucket ?? "",
    ossEndpoint: shop?.ossEndpoint ?? "",
    ossPublicDomain: shop?.ossPublicDomain ?? "",
    watermarkPath: shop?.watermarkPath ?? "",
    shopRole: shop?.shopRole ?? "main",
    followsShopId: shop?.followsShopId ?? "",
    followWarehouseId: shop?.followWarehouseId,
    maintenanceWarehouseId: shop?.maintenanceWarehouseId,
    maintenanceStock: shop?.maintenanceStock ?? 50,
    maintenanceStockEnabled: shop?.maintenanceStockEnabled ?? true,
    maintenanceBarcodeEnabled: shop?.maintenanceBarcodeEnabled ?? true,
    maintenanceActionEnabled: (shop?.maintenanceActionEnabled ?? true) || (shop?.maintenanceActionConfigs ?? []).length > 0,
    maintenanceIntervalMinutes: shop?.maintenanceIntervalMinutes ?? 5,
    maintenanceActionConfigs: shop?.maintenanceActionConfigs ?? [],
    enabled: shop?.enabled ?? true,
  };
}

function normalizeSavedTab(tab: unknown): TabKey {
  return typeof tab === "string" && TASK_TABS.some((item) => item.key === tab) ? tab as TabKey : "upload";
}

function PreflightSection({ issues, onNavigate }: { issues: PreflightIssue[]; onNavigate: (page: "ozon" | "jobs") => void }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>开始前预检查</h2>
      </div>
      <PreflightPanel issues={issues} onAction={(target) => {
        if (target === "settings" || target === "ozon") onNavigate("ozon");
        if (target === "jobs") onNavigate("jobs");
      }} />
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstResultItem(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const result = value.result;
  if (Array.isArray(result)) return result[0];
  if (isRecord(result)) {
    if (Array.isArray(result.items)) return result.items[0];
    if (Array.isArray(result.products)) return result.products[0];
    return result;
  }
  if (Array.isArray(value.items)) return value.items[0];
  if (Array.isArray(value.products)) return value.products[0];
  return undefined;
}

function extractAttributes(attributes: unknown, product: unknown): unknown[] {
  if (isRecord(attributes)) {
    if (Array.isArray(attributes.attributes)) return attributes.attributes;
  }
  if (isRecord(product) && Array.isArray(product.attributes)) {
    return product.attributes;
  }
  return [];
}

function readCurrentTemplatePayload(templateProduct: unknown | undefined, templateJson: string) {
  if (templateJson.trim()) {
    try {
      return JSON.parse(templateJson);
    } catch {
      throw new Error("JSON 模板格式不正确，请先修正后再保存");
    }
  }
  if (templateProduct) return templateProduct;
  throw new Error("请先读取线上模板，或粘贴 JSON 后再保存");
}

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error:\s*/i, "").trim() || "操作失败，请查看页面提示。";
}

function responseNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function parseActions(value: unknown): ActionRow[] {
  return extractArray(value, ["actions", "items"]).map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      id: Number(record.id ?? record.action_id ?? 0),
      title: String(record.title ?? record.name ?? record.action_name ?? "未命名活动"),
      dateStart: scalarText(record.date_start ?? record.dateStart),
      dateEnd: scalarText(record.date_end ?? record.dateEnd),
      status: scalarText(record.status ?? record.state),
    };
  }).filter((action) => action.id > 0);
}

function parseActionProducts(value: unknown): ActionProductRow[] {
  return extractArray(value, ["products", "items"]).map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      productId: numberValue(record.product_id ?? record.productId ?? record.id),
      offerId: scalarText(record.offer_id ?? record.offerId ?? record.sku) ?? "",
      name: scalarText(record.name ?? record.title ?? record.product_name ?? record.productName) ?? "",
      primaryImage: imageUrlFrom(record),
      productUrl: productUrlFrom(record),
      price: priceText(record.price ?? record.current_price ?? record.currentPrice),
      currencyCode: scalarText(record.currency_code ?? record.currencyCode),
      actionPrice: priceText(record.action_price ?? record.actionPrice),
      stock: numberValue(record.stock ?? record.action_stock ?? record.actionStock),
      discount: numberValue(record.discount ?? record.discount_percent ?? record.discountPercent),
      maxActionPrice: priceText(record.max_action_price ?? record.maxActionPrice),
      minActionPrice: priceText(record.min_action_price ?? record.minActionPrice),
      status: scalarText(record.status ?? record.state),
      raw: record,
    };
  });
}

function lightweightActionProductRow(row: ActionProductRow): ActionProductRow {
  return {
    productId: row.productId,
    offerId: row.offerId,
    name: row.name,
    primaryImage: row.primaryImage,
    productUrl: row.productUrl,
    price: row.price,
    currencyCode: row.currencyCode,
    actionPrice: row.actionPrice,
    stock: row.stock,
    discount: row.discount,
    maxActionPrice: row.maxActionPrice,
    minActionPrice: row.minActionPrice,
    status: row.status,
    raw: {},
  };
}

async function enrichActionProducts(shopId: string, rows: ActionProductRow[]): Promise<ActionProductRow[]> {
  const productIds = rows
    .map((row) => row.productId)
    .filter((id): id is number => typeof id === "number");
  if (productIds.length === 0) return rows;

  const detailsById = new Map<number, Record<string, unknown>>();
  for (const chunk of chunkArray(Array.from(new Set(productIds)), 1000)) {
    const data = await api.getProductInfoByProductIds(shopId, chunk);
    for (const item of extractArray(data, ["items", "products"])) {
      if (!isRecord(item)) continue;
      const productId = numberValue(item.product_id ?? item.productId ?? item.id);
      if (productId) detailsById.set(productId, item);
    }
  }

  return rows.map((row) => {
    const detail = row.productId ? detailsById.get(row.productId) : undefined;
    if (!detail) return row;
    return {
      ...row,
      offerId: row.offerId || scalarText(detail.offer_id ?? detail.offerId) || "",
      name: row.name || scalarText(detail.name ?? detail.title) || "",
      primaryImage: row.primaryImage || imageUrlFrom(detail),
      productUrl: row.productUrl || productUrlFrom({ ...detail, ...row.raw }),
      price: row.price || priceText(detail.price),
      currencyCode: row.currencyCode || scalarText(detail.currency_code ?? detail.currencyCode),
      raw: { ...detail, ...row.raw },
    };
  });
}

function extractArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (Array.isArray(value.result)) return value.result;
  if (isRecord(value.result)) {
    for (const key of keys) {
      if (Array.isArray(value.result[key])) return value.result[key];
    }
  }
  return [];
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function priceText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!isRecord(value)) return undefined;
  return scalarText(value.price)
    ?? scalarText(value.value)
    ?? scalarText(value.amount)
    ?? scalarText(value.old_price);
}

function imageUrlFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    return isLikelyImageUrl(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = imageUrlFrom(item);
      if (url) return url;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  for (const key of [
    "primary_image",
    "primaryImage",
    "image_url",
    "imageUrl",
    "image",
    "picture",
    "url",
    "file_name",
    "fileName",
    "src",
  ]) {
    const url = imageUrlFrom(value[key]);
    if (url) return url;
  }
  for (const key of ["images", "pictures", "media", "sources", "photos"]) {
    const url = imageUrlFrom(value[key]);
    if (url) return url;
  }
  return undefined;
}

function isLikelyImageUrl(value: string): boolean {
  const text = value.trim();
  return /^https?:\/\//i.test(text)
    && (
      /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(text)
      || /ir\.ozone\.ru|cdn|image|img|photo|picture/i.test(text)
    );
}

function productUrlFrom(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const directUrl = scalarText(value.product_url ?? value.productUrl ?? value.url);
  if (directUrl?.startsWith("http")) return directUrl;
  const productId = numberValue(value.product_id ?? value.productId ?? value.id);
  return productId ? `https://www.ozon.ru/product/${productId}/` : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function ActionPanel(props: {
  actions: ActionRow[];
  selectedActionId: number | "";
  setSelectedActionId: (value: number | "") => void;
  actionProducts: ActionProductRow[];
  actionCandidates: ActionProductRow[];
  selectedActionProductIds: number[];
  setSelectedActionProductIds: (value: number[]) => void;
  selectedActionCandidateIds: number[];
  setSelectedActionCandidateIds: (value: number[]) => void;
  actionProductLimit: number;
  setActionProductLimit: (value: number) => void;
  actionProductLastId: string;
  nextActionProductLastId: string;
  actionCandidateLastId: string;
  nextActionCandidateLastId: string;
  actionPrice: string;
  setActionPrice: (value: string) => void;
  actionStock: number;
  setActionStock: (value: number) => void;
  selectedProductCount: number;
  loadActions: () => void;
  loadActionProducts: (lastId: string) => void;
  loadActionCandidates: (lastId: string) => void;
  addSelectedProducts: () => void;
  removeSelectedProducts: () => void;
  removeAllProducts: () => void;
  deleteAllPending: boolean;
  setResult: (value: string) => void;
}) {
  return (
    <div className="panel-subsection">
      <div className="section-title">
        <span className="step-dot">2</span>
        <div>
          <h2>再处理活动商品</h2>
          <p className="muted">新增活动商品请从“可参加商品”里勾选；删除活动商品请从“已参加商品”里勾选。</p>
        </div>
      </div>
      <div className="guide-grid">
        <div className="guide-card">
          <strong>1. 选择活动</strong>
          <span>先点“查询活动”，再从下拉框选择活动。</span>
        </div>
        <div className="guide-card">
          <strong>2. 新增商品</strong>
          <span>点“查询可参加商品”，勾选后点“新增参加活动”。</span>
        </div>
        <div className="guide-card">
          <strong>3. 删除商品</strong>
          <span>点“查询已参加商品”，勾选后点“删除参加活动”。</span>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>活动</label>
          <select value={props.selectedActionId} onChange={(event) => props.setSelectedActionId(event.target.value ? Number(event.target.value) : "")}>
            <option value="">选择活动</option>
            {props.actions.map((action) => (
              <option key={action.id} value={action.id}>
                {action.title} ({action.id}) {action.status ? ` ${action.status}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>每页数量</label>
          <input type="number" min={1} max={1000} value={props.actionProductLimit} onChange={(event) => props.setActionProductLimit(Number(event.target.value))} />
        </div>
        <div className="field">
          <label>统一活动价</label>
          <input value={props.actionPrice} onChange={(event) => props.setActionPrice(event.target.value)} placeholder="不填则使用接口返回建议价/当前价" />
        </div>
        <div className="field">
          <label>活动库存</label>
          <input type="number" min={1} value={props.actionStock} onChange={(event) => props.setActionStock(Number(event.target.value))} />
        </div>
      </div>
      <div className="toolbar action-row">
        <button className="secondary-button" onClick={props.loadActions}>查询活动</button>
        <button className="secondary-button" disabled={!props.selectedActionId} onClick={() => props.loadActionCandidates("")}>查询可参加商品</button>
        <button className="secondary-button" disabled={!props.selectedActionId} onClick={() => props.loadActionProducts("")}>查询已参加商品</button>
        <span className="muted">普通商品表已勾选 {props.selectedProductCount} 个，不会直接用于新增活动。</span>
      </div>

      <div className="split-panels">
        <ActionProductTable
          title="可参加商品"
          emptyText="选择活动后点击“查询可参加商品”。"
          products={props.actionCandidates}
          selectedIds={props.selectedActionCandidateIds}
          setSelectedIds={props.setSelectedActionCandidateIds}
          setResult={props.setResult}
        />
        <ActionProductTable
          title="已参加商品"
          emptyText="选择活动后点击“查询已参加商品”。"
          products={props.actionProducts}
          selectedIds={props.selectedActionProductIds}
          setSelectedIds={props.setSelectedActionProductIds}
          setResult={props.setResult}
        />
      </div>

      <div className="toolbar action-row">
        <button className="primary-button" disabled={!props.selectedActionId || props.selectedActionCandidateIds.length === 0} onClick={props.addSelectedProducts}>
          新增参加活动 ({props.selectedActionCandidateIds.length})
        </button>
        <button className="danger-button" disabled={!props.selectedActionId || props.selectedActionProductIds.length === 0} onClick={props.removeSelectedProducts}>
          删除参加活动 ({props.selectedActionProductIds.length})
        </button>
        <button className="danger-button" disabled={!props.selectedActionId} onClick={props.removeAllProducts}>
          {props.deleteAllPending ? "确认删除当前活动所有商品" : "删除当前活动所有商品"}
        </button>
        <button className="secondary-button" disabled={!props.nextActionCandidateLastId} onClick={() => props.loadActionCandidates(props.nextActionCandidateLastId)}>
          下一页可参加商品
        </button>
        {props.actionCandidateLastId ? <button className="secondary-button" onClick={() => props.loadActionCandidates("")}>回到第一页可参加商品</button> : null}
        <button className="secondary-button" disabled={!props.nextActionProductLastId} onClick={() => props.loadActionProducts(props.nextActionProductLastId)}>下一页已参加商品</button>
        {props.actionProductLastId ? <button className="secondary-button" onClick={() => props.loadActionProducts("")}>回到第一页已参加商品</button> : null}
      </div>
    </div>
  );
}

function ActionProductTable(props: {
  title: string;
  emptyText: string;
  products: ActionProductRow[];
  selectedIds: number[];
  setSelectedIds: (value: number[]) => void;
  setResult: (value: string) => void;
}) {
  const productIds = props.products.map((product) => product.productId).filter((id): id is number => typeof id === "number");
  const selectedSet = new Set(props.selectedIds);
  const toggleProduct = (productId: number, checked: boolean) => {
    props.setSelectedIds(checked
      ? Array.from(new Set([...props.selectedIds, productId]))
      : props.selectedIds.filter((id) => id !== productId));
  };
  const toggleAll = (checked: boolean) => {
    props.setSelectedIds(checked ? Array.from(new Set(productIds)) : []);
  };
  return (
    <div className="mini-panel">
      <div className="panel-header">
        <h3>{props.title}</h3>
        <span className="muted">{props.products.length} 个，已勾选 {props.selectedIds.length} 个</span>
      </div>
      <div className="table-wrap compact-table">
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" checked={productIds.length > 0 && productIds.every((id) => selectedSet.has(id))} onChange={(event) => toggleAll(event.target.checked)} /></th>
              <th>商品信息</th><th>售价</th><th>活动价</th><th>库存</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            {props.products.map((product, index) => (
              <tr key={`${product.productId ?? product.offerId}-${index}`}>
                <td>
                  {product.productId ? (
                    <input type="checkbox" checked={selectedSet.has(product.productId)} onChange={(event) => toggleProduct(product.productId!, event.target.checked)} />
                  ) : null}
                </td>
                <td><ProductSummary product={product} setResult={props.setResult} /></td>
                <td>{[product.price, product.currencyCode].filter(Boolean).join(" ") || "-"}</td>
                <td>
                  <div>{product.actionPrice || "-"}</div>
                  {(product.minActionPrice || product.maxActionPrice) ? (
                    <div className="muted">范围 {product.minActionPrice || "-"} - {product.maxActionPrice || "-"}</div>
                  ) : null}
                </td>
                <td>{product.stock ?? "-"}</td>
                <td>{product.status || "-"}</td>
              </tr>
            ))}
            {props.products.length === 0 ? <tr><td colSpan={6} className="muted">{props.emptyText}</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProductSummary(props: { product: ActionProductRow; setResult: (value: string) => void }) {
  const imageUrl = props.product.primaryImage || imageUrlFrom(props.product.raw);
  const url = props.product.productUrl || productUrlFrom(props.product.raw);
  return (
    <div className="product-cell">
      {imageUrl ? (
        <span className="product-thumb">
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
          <span>无图</span>
        </span>
      ) : <span className="product-thumb-empty">无图</span>}
      <div>
        {url ? (
          <button
            className="product-title-link"
            type="button"
            onClick={() => api.openUrl(url).catch((error) => props.setResult(String(error)))}
          >
            {props.product.name || "未返回商品标题"}
          </button>
        ) : (
          <strong>{props.product.name || "未返回商品标题"}</strong>
        )}
        <span>货号: {props.product.offerId || "未返回"}</span>
        <span>商品 ID: {props.product.productId ?? "-"}</span>
      </div>
    </div>
  );
}

function InventoryTable(props: {
  products: OzonProductRow[];
  selectedProductIds: number[];
  setSelectedProductIds: (value: number[]) => void;
  page: number;
  setPage: (value: number) => void;
  pageSize: number;
  setPageSize: (value: number) => void;
  shopId: string;
  warehouseId: number | "";
  stockValue: number;
  newPrice: string;
  newOldPrice: string;
  currencyCode: string;
  setResult: (value: string) => void;
  setFeedback: (value: OperationFeedback | null) => void;
}) {
  const [operationRunning, setOperationRunning] = useState<"stock" | "price" | "barcode" | null>(null);
  const operationProducts = selectInventoryProducts(props.products, props.selectedProductIds);
  const productIds = operationProducts.map((row) => row.productId).filter((id): id is number => typeof id === "number");
  const totalPages = Math.max(1, Math.ceil(props.products.length / Math.max(1, props.pageSize)));
  const page = Math.min(props.page, totalPages);
  const pageRows = props.products.slice((page - 1) * props.pageSize, page * props.pageSize);
  const pageProductIds = pageRows.map((row) => row.productId).filter((id): id is number => typeof id === "number");
  const selectedSet = new Set(props.selectedProductIds);
  const toggleProduct = (productId: number, checked: boolean) => {
    props.setSelectedProductIds(checked
      ? Array.from(new Set([...props.selectedProductIds, productId]))
      : props.selectedProductIds.filter((id) => id !== productId));
  };
  const togglePage = (checked: boolean) => {
    if (checked) {
      props.setSelectedProductIds(Array.from(new Set([...props.selectedProductIds, ...pageProductIds])));
      return;
    }
    props.setSelectedProductIds(props.selectedProductIds.filter((id) => !pageProductIds.includes(id)));
  };
  const runInventoryOperation = async (
    key: "stock" | "price" | "barcode",
    action: () => Promise<string>,
  ) => {
    setOperationRunning(key);
    props.setFeedback({ tone: "running", message: "正在提交到 Ozon，请稍等..." });
    try {
      const message = await action();
      props.setFeedback({ tone: "success", message });
    } catch (error) {
      const message = friendlyError(error);
      props.setFeedback({ tone: "error", message });
      props.setResult(message);
    } finally {
      setOperationRunning(null);
    }
  };
  const updateStocks = async () => {
    if (!props.shopId) throw new Error("请先选择店铺");
    if (!props.warehouseId) throw new Error("请先选择仓库");
    const stocks = productIds.map((productId) => ({
      product_id: productId,
      stock: props.stockValue,
      warehouse_id: props.warehouseId,
    }));
    const results = [];
    for (const [index, chunk] of chunkArray(stocks, 100).entries()) {
      const data = await api.updateStocks(props.shopId, chunk);
      results.push({ batch: index + 1, count: chunk.length, data });
    }
    props.setResult(JSON.stringify({ batches: results.length, total: stocks.length, results }, null, 2));
    return `库存更新已提交：${stocks.length} 个商品，库存更新为 ${props.stockValue}，仓库 ${props.warehouseId}，共 ${results.length} 个批次。`;
  };
  const updatePrices = async () => {
    if (!props.shopId) throw new Error("请先选择店铺");
    if (!props.newPrice.trim()) throw new Error("请先填写新售价");
    const prices = operationProducts.map((product) => {
      const currencyCode = product.currencyCode || props.currencyCode.trim();
      if (!currencyCode) throw new Error(`${product.offerId} 缺少商品原币种，请先按分类重新查询商品，或填写备用币种`);
      return {
        offer_id: product.offerId,
        price: props.newPrice.trim(),
        old_price: props.newOldPrice.trim(),
        currency_code: currencyCode,
      };
    });
    const results = [];
    for (const [index, chunk] of chunkArray(prices, 100).entries()) {
      const data = await api.updatePrices(props.shopId, chunk);
      results.push({ batch: index + 1, count: chunk.length, data });
    }
    props.setResult(JSON.stringify({ batches: results.length, total: prices.length, results }, null, 2));
    return `价格更新已提交：${prices.length} 个商品，售价更新为 ${props.newPrice.trim()}${props.newOldPrice.trim() ? `，划线价更新为 ${props.newOldPrice.trim()}` : ""}，共 ${results.length} 个批次。`;
  };
  const generateBarcodes = async () => {
    if (!props.shopId) throw new Error("请先选择店铺");
    const results = [];
    for (const [index, chunk] of chunkArray(productIds, 100).entries()) {
      const data = await api.generateBarcodes(props.shopId, chunk);
      results.push({ batch: index + 1, count: chunk.length, data });
    }
    props.setResult(JSON.stringify({ batches: results.length, total: productIds.length, results }, null, 2));
    return `条码生成已提交：${productIds.length} 个商品，共 ${results.length} 个批次。`;
  };

  return (
    <>
      <div className="operation-grid">
        <div className="operation-card">
          <strong>{props.selectedProductIds.length > 0 ? "所选商品更新库存" : "当前列表更新库存"}</strong>
          <span>有勾选时仅处理勾选商品；未勾选时处理当前列表全部商品。</span>
          <button className="primary-button" disabled={productIds.length === 0 || operationRunning !== null} onClick={() => runInventoryOperation("stock", updateStocks)}>
            {operationRunning === "stock" ? "提交中" : "更新列表库存"}
          </button>
        </div>
        <div className="operation-card">
          <strong>{props.selectedProductIds.length > 0 ? "所选商品更新价格" : "当前列表更新价格"}</strong>
          <span>有勾选时仅处理勾选商品；未勾选时处理当前列表全部商品。</span>
          <button className="primary-button" disabled={operationProducts.length === 0 || operationRunning !== null} onClick={() => runInventoryOperation("price", updatePrices)}>
            {operationRunning === "price" ? "提交中" : "更新列表价格"}
          </button>
        </div>
        <div className="operation-card">
          <strong>生成条码</strong>
          <span>有勾选时仅处理勾选商品；未勾选时处理当前列表全部商品。</span>
          <button className="secondary-button" disabled={productIds.length === 0 || operationRunning !== null} onClick={() => runInventoryOperation("barcode", generateBarcodes)}>
            {operationRunning === "barcode" ? "提交中" : "生成条码"}
          </button>
        </div>
      </div>
      <div className="product-list-header">
        <div>
          <h3>商品列表</h3>
          <span className="muted">当前页显示 {pageRows.length} 条，已勾选 {props.selectedProductIds.length} 个，本次操作 {operationProducts.length} 个。</span>
        </div>
        <span className="badge neutral">共 {props.products.length} 个商品</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" checked={pageProductIds.length > 0 && pageProductIds.every((id) => selectedSet.has(id))} onChange={(event) => togglePage(event.target.checked)} /></th>
              <th>货号</th><th>商品</th><th>分类</th><th>库存</th><th>售价</th><th>条码</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((product) => (
              <tr key={product.offerId}>
                <td>
                  {product.productId ? (
                    <input type="checkbox" checked={selectedSet.has(product.productId)} onChange={(event) => toggleProduct(product.productId!, event.target.checked)} />
                  ) : null}
                </td>
                <td>{product.offerId}</td>
                <td>{product.name || "-"}</td>
                <td>{[product.categoryName || product.categoryId, product.typeName || product.typeId].filter(Boolean).join(" / ") || "-"}</td>
                <td>{product.stockSummary || "-"}</td>
                <td>{[product.price, product.oldPrice ? `划线 ${product.oldPrice}` : "", product.currencyCode].filter(Boolean).join(" / ") || "-"}</td>
                <td>{product.hasBarcode === false ? "无" : "有/未知"}</td>
              </tr>
            ))}
            {props.products.length === 0 ? <tr><td colSpan={7} className="muted">先点击上方按钮拉取商品。</td></tr> : null}
          </tbody>
        </table>
      </div>
      <PaginationBar
        total={props.products.length}
        page={page}
        totalPages={totalPages}
        pageSize={props.pageSize}
        setPage={props.setPage}
        setPageSize={(size) => {
          props.setPageSize(size);
          props.setPage(1);
        }}
      />
    </>
  );
}

function PaginationBar(props: {
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
  setPage: (value: number) => void;
  setPageSize: (value: number) => void;
}) {
  return (
    <div className="pagination-bar">
      <span>共 {props.total} 条</span>
      <select value={props.pageSize} onChange={(event) => props.setPageSize(Number(event.target.value))}>
        {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size} 条/页</option>)}
      </select>
      <button className="secondary-button" disabled={props.page <= 1} onClick={() => props.setPage(1)}>首页</button>
      <button className="secondary-button" disabled={props.page <= 1} onClick={() => props.setPage(props.page - 1)}>上一页</button>
      <span>第 {props.page} / {props.totalPages} 页</span>
      <button className="secondary-button" disabled={props.page >= props.totalPages} onClick={() => props.setPage(props.page + 1)}>下一页</button>
      <button className="secondary-button" disabled={props.page >= props.totalPages} onClick={() => props.setPage(props.totalPages)}>末页</button>
    </div>
  );
}
