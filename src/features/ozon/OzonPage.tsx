import { useEffect, useState } from "react";
import type { AppSettings, CategoryOption, OzonProductRow, PreflightIssue, ProductAnalyticsRow, Shop, TemplateSummary, WarehouseOption } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";
import { LongOutput } from "../../lib/LongOutput";
import { hasBlockingIssues, PreflightPanel } from "../../lib/PreflightPanel";
import { buildActionProductPayload, extractNextLastId } from "./actionUtils";
import { selectInventoryProducts } from "./inventoryUtils";
import { parseOrderNumbers } from "./orderUtils";

interface Props {
  shops: Shop[];
  settings: AppSettings;
  onChanged: () => void;
  onNavigate: (page: "settings" | "jobs") => void;
}

type TabKey = "overview" | "upload" | "update" | "orders" | "inventory" | "analytics" | "api";
type InventoryMode = "products" | "actions";
type CategoryUpdateMode = "stock" | "price" | "both";
const PRODUCT_TEMPLATE_KIND = "product_import";
const TASK_TABS: Array<{ key: TabKey; label: string; description: string; primaryAction: string }> = [
  { key: "overview", label: "任务总览", description: "从业务目标进入对应工具，适合日常操作开始页。", primaryAction: "查看路径" },
  { key: "upload", label: "发布新品", description: "用 Excel、图片目录和商品模板创建 Ozon 上架任务。", primaryAction: "去发布" },
  { key: "update", label: "更新商品", description: "按货号更新已上架商品的标题、图片、视频和富内容。", primaryAction: "去更新" },
  { key: "orders", label: "下载订单文件", description: "按订单或货件编号下载标签、条码、拣货单和货号素材。", primaryAction: "去下载" },
  { key: "inventory", label: "库存价格活动", description: "查询商品后批量补库存、改价、生成条码或申报活动。", primaryAction: "去运维" },
  { key: "analytics", label: "浏览量与合并", description: "查看商品浏览量，并将同类目商品每 20 个合并为一张商品卡。", primaryAction: "去分析" },
  { key: "api", label: "接口诊断", description: "检查 Ozon 连接、仓库返回和接口原始结果。", primaryAction: "去诊断" },
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
  orderNumbersText?: string;
  orderOutputRoot?: string;
  ozonSellerHarPath?: string;
  ozonSellerCookiePath?: string;
  baiduSearchDir?: string;
  baiduRecursive?: boolean;
  downloadMaterials?: boolean;
}

interface ListedUpdateDraft {
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
}

const QUERY_CACHE_PREFIX = "ozon-sjsq:query-cache:v1";
const ORDER_DOCUMENTS_DRAFT_KEY = "ozon-sjsq:order-documents-draft:v1";
const LISTED_UPDATE_DRAFT_KEY = "ozon-sjsq:listed-update-draft:v1";
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
  window.localStorage.setItem(queryCacheKey(shopId, name), JSON.stringify({
    savedAt: new Date().toISOString(),
    data,
  }));
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

export function OzonPage({ shops, settings, onChanged, onNavigate }: Props) {
  const savedOrderDraft = readOrderDocumentsDraft();
  const savedUpdateDraft = readListedUpdateDraft();
  const [tab, setTab] = useState<TabKey>(savedUpdateDraft.tab ?? "overview");
  const [shopId, setShopId] = useState<string>(shops.find((shop) => shop.enabled)?.id ?? shops[0]?.id ?? "");
  const [shopCenterOpen, setShopCenterOpen] = useState(false);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [warehousesLoading, setWarehousesLoading] = useState(false);
  const [warehouseError, setWarehouseError] = useState("");
  const [result, setResult] = useState("");
  const [friendlyMessage, setFriendlyMessage] = useState("");
  const [friendlyTone, setFriendlyTone] = useState<"info" | "error">("info");
  const [issues, setIssues] = useState<PreflightIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const [portraitRoot, setPortraitRoot] = useState(savedUpdateDraft.portraitRoot ?? settings.defaultOutputRoot);
  const [excelPath, setExcelPath] = useState(savedUpdateDraft.excelPath ?? settings.uploadExcelPath);
  const [maxItems, setMaxItems] = useState(savedUpdateDraft.maxItems ?? (settings.uploadMaxItems || 100));
  const [templateVideoLinks, setTemplateVideoLinks] = useState(savedUpdateDraft.templateVideoLinks ?? "");
  const [updateTitle, setUpdateTitle] = useState(savedUpdateDraft.updateTitle ?? true);
  const [updateDescription, setUpdateDescription] = useState(savedUpdateDraft.updateDescription ?? true);
  const [updateImages, setUpdateImages] = useState(savedUpdateDraft.updateImages ?? true);
  const [updateVideo, setUpdateVideo] = useState(savedUpdateDraft.updateVideo ?? false);
  const [updateRichJson, setUpdateRichJson] = useState(savedUpdateDraft.updateRichJson ?? false);
  const [orderNumbersText, setOrderNumbersText] = useState(savedOrderDraft.orderNumbersText ?? "");
  const [orderOutputRoot, setOrderOutputRoot] = useState(savedOrderDraft.orderOutputRoot ?? settings.defaultOutputRoot);
  const [ozonSellerHarPath, setOzonSellerHarPath] = useState(savedOrderDraft.ozonSellerHarPath ?? "");
  const [ozonSellerCookiePath, setOzonSellerCookiePath] = useState(savedOrderDraft.ozonSellerCookiePath ?? "");
  const [baiduCookie, setBaiduCookie] = useState(settings.baiduCookie);
  const [baiduSearchDir, setBaiduSearchDir] = useState(savedOrderDraft.baiduSearchDir ?? "/");
  const [baiduRecursive, setBaiduRecursive] = useState(savedOrderDraft.baiduRecursive ?? true);
  const [downloadMaterials, setDownloadMaterials] = useState(savedOrderDraft.downloadMaterials ?? false);
  const [products, setProducts] = useState<OzonProductRow[]>([]);
  const [inventoryMode, setInventoryMode] = useState<InventoryMode>("products");
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  const [productPage, setProductPage] = useState(1);
  const [productPageSize, setProductPageSize] = useState(10);
  const [stockValue, setStockValue] = useState(10);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<number | "">("");
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | "">("");
  const [categoryKeyword, setCategoryKeyword] = useState("");
  const [categoryLimit, setCategoryLimit] = useState(100);
  const [newPrice, setNewPrice] = useState("");
  const [newOldPrice, setNewOldPrice] = useState("");
  const [currencyCode, setCurrencyCode] = useState("");
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(savedUpdateDraft.selectedTemplateId ?? "");
  const [templateName, setTemplateName] = useState(savedUpdateDraft.templateName ?? "");
  const [templateOfferId, setTemplateOfferId] = useState(savedUpdateDraft.templateOfferId ?? "");
  const [templateJson, setTemplateJson] = useState("");
  const [templateProduct, setTemplateProduct] = useState<unknown | undefined>(undefined);
  const [templateStatus, setTemplateStatus] = useState("未选择商品模板");
  const [previewSku, setPreviewSku] = useState("SKU-PREVIEW");
  const [previewTitle, setPreviewTitle] = useState("预览商品标题");
  const [previewDescription, setPreviewDescription] = useState("预览商品简介");
  const [previewImageUrls, setPreviewImageUrls] = useState("https://example.com/image-1.jpg");
  const [previewPayload, setPreviewPayload] = useState("");
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [selectedActionId, setSelectedActionId] = useState<number | "">("");
  const [pendingDeleteAllActionId, setPendingDeleteAllActionId] = useState<number | "">("");
  const [actionProducts, setActionProducts] = useState<ActionProductRow[]>([]);
  const [actionCandidates, setActionCandidates] = useState<ActionProductRow[]>([]);
  const [selectedActionProductIds, setSelectedActionProductIds] = useState<number[]>([]);
  const [selectedActionCandidateIds, setSelectedActionCandidateIds] = useState<number[]>([]);
  const [actionProductLimit, setActionProductLimit] = useState(100);
  const [actionProductLastId, setActionProductLastId] = useState("");
  const [nextActionProductLastId, setNextActionProductLastId] = useState("");
  const [actionCandidateLastId, setActionCandidateLastId] = useState("");
  const [nextActionCandidateLastId, setNextActionCandidateLastId] = useState("");
  const [actionPrice, setActionPrice] = useState("");
  const [actionStock, setActionStock] = useState(10);
  const [autoPostProcess, setAutoPostProcess] = useState(false);
  const [analyticsDateFrom, setAnalyticsDateFrom] = useState(dateInputValue(29));
  const [analyticsDateTo, setAnalyticsDateTo] = useState(dateInputValue(0));
  const [analyticsLimit, setAnalyticsLimit] = useState(1000);
  const [minimumCardViews, setMinimumCardViews] = useState(1);
  const [analyticsRows, setAnalyticsRows] = useState<ProductAnalyticsRow[]>([]);
  const [selectedAnalyticsProductIds, setSelectedAnalyticsProductIds] = useState<number[]>([]);
  const [mergeConfirmPending, setMergeConfirmPending] = useState(false);

  const uploadRequest = () => ({
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

  const updateRequest = () => ({
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
  });

  const orderDocumentsRequest = () => ({
    shopId,
    orderNumbers: parseOrderNumbers(orderNumbersText),
    outputRoot: orderOutputRoot,
    ozonCompanyId: currentShop?.clientId,
    ozonSellerHarPath,
    ozonSellerCookiePath,
    baiduCookie,
    baiduSearchDir,
    baiduRecursive,
    downloadMaterials,
  });

  const currentShop = shops.find((shop) => shop.id === shopId);
  const analyticsMaxDate = dateInputValue(0);
  const visibleAnalyticsRows = analyticsRows.filter((row) => row.cardViews >= minimumCardViews);

  useEffect(() => {
    writeOrderDocumentsDraft({
      orderNumbersText,
      orderOutputRoot,
      ozonSellerHarPath,
      ozonSellerCookiePath,
      baiduSearchDir,
      baiduRecursive,
      downloadMaterials,
    });
  }, [
    orderNumbersText,
    orderOutputRoot,
    ozonSellerHarPath,
    ozonSellerCookiePath,
    baiduSearchDir,
    baiduRecursive,
    downloadMaterials,
  ]);

  useEffect(() => {
    writeListedUpdateDraft({
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
    });
  }, [
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
  ]);

  const loadWarehouses = async (id: string) => {
    if (!id) {
      setWarehouses([]);
      setWarehouseError("请先在设置页保存店铺，并选择店铺后获取仓库。");
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

  const applyCachedShopData = (id: string) => {
    const cachedWarehouses = readQueryCache<WarehouseOption[]>(id, "warehouses");
    setWarehouses(cachedWarehouses?.data ?? []);
    setWarehouseError(cachedWarehouses ? "" : "暂无本地仓库缓存，点击刷新仓库后会查询 Ozon。");
    setSelectedWarehouseId((current) => current || cachedWarehouses?.data[0]?.warehouseId || "");

    const cachedCategories = readQueryCache<CategoryOption[]>(id, "categories");
    setCategories(cachedCategories?.data ?? []);
    setSelectedCategoryId("");

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

  const submitOrderDocuments = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      if (parseOrderNumbers(orderNumbersText).length === 0) throw new Error("请至少输入一个订单/货件编号");
      if (!orderOutputRoot.trim()) throw new Error("请选择输出目录");
      if (!ozonSellerHarPath.trim() && !ozonSellerCookiePath.trim()) {
        throw new Error("请选择 Ozon 后台 HAR，或粘贴 Ozon 后台 Cookie");
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

  const saveBaiduCookie = async () => {
    const cookie = baiduCookie.trim();
    if (!cookie) throw new Error("请先填写百度网盘 Cookie");
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

  const loadCategories = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    const data = await api.listCategories(shopId);
    setCategories(data);
    writeQueryCache(shopId, "categories", data);
    setSelectedCategoryId((current) => {
      if (current && data.some((category) => category.id === current)) return current;
      const keyword = categoryKeyword.trim().toLowerCase();
      if (!keyword) return "";
      const matches = data.filter((category) => categorySearchText(category).includes(keyword));
      const exact = matches.find((category) => category.name.toLowerCase() === keyword);
      return (exact ?? (matches.length === 1 ? matches[0] : undefined))?.id ?? "";
    });
    setResult(`已加载 ${data.length} 个商品分类。`);
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
    setResult(`已按分类拉取 ${rows.length} 个商品。`);
  };

  const updateSelectedCategoryProducts = async (mode: CategoryUpdateMode) => {
    await run(async () => {
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
        warehouseId: typeof selectedWarehouseId === "number" ? selectedWarehouseId : undefined,
        stock: stockValue,
        price: newPrice.trim(),
        oldPrice: newOldPrice.trim(),
        currencyCode: currencyCode.trim(),
        updateStock,
        updatePrice,
      });
      setResult(JSON.stringify(data, null, 2));
      setFriendlyMessage(`已提交“${selected.name}”类目全部商品的${updateStock && updatePrice ? "库存和价格" : updateStock ? "库存" : "价格"}更新。`);
    });
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
      rows: enrichedRows,
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
    setPreviewPayload("");
  };

  const clearTemplateState = () => {
    setSelectedTemplateId("");
    setTemplateName("");
    setTemplateProduct(undefined);
    setTemplateJson("");
    setPreviewPayload("");
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
    if (!templateProduct) throw new Error("请先读取或粘贴模板");
    const saved = await api.saveTemplate({
      id: selectedTemplateId || undefined,
      kind: PRODUCT_TEMPLATE_KIND,
      name: templateName.trim() || templateOfferId.trim() || "商品导入模板",
      payload: templateProduct,
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

  const previewTemplatePayload = async () => {
    const payload = await api.buildImportPreview({
      templateProduct: templateProduct ?? {},
      offerId: previewSku,
      title: previewTitle,
      description: previewDescription,
      imageUrls: previewImageUrls.split("\n").map((item) => item.trim()).filter(Boolean),
      videoLinks: templateVideoLinks.split("\n").map((item) => item.trim()).filter(Boolean),
      richJson: undefined,
    });
    setPreviewPayload(JSON.stringify(payload, null, 2));
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
    if (shopId) {
      applyCachedShopData(shopId);
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
      setWarehouseError("请先在设置页保存店铺，并选择店铺后获取仓库。");
    }
  }, [shopId]);

  useEffect(() => {
    loadTemplates(true).catch((error) => setResult(String(error)));
  }, []);

  const openShopCenter = (id: string) => {
    setShopId(id);
    setTab("overview");
    setShopCenterOpen(true);
  };

  if (!shopCenterOpen) {
    return (
      <div className="content-grid">
        <ShopManagementPanel
          shops={shops}
          selectedShopId={shopId}
          onSelectShop={setShopId}
          onOpenShopCenter={openShopCenter}
          onSettings={() => onNavigate("settings")}
        />
      </div>
    );
  }

  return (
    <div className="content-grid">
      <section className="panel shop-workspace shop-workspace-center">
        <div className="shop-detail">
          <div className="shop-hero">
            <div className="shop-avatar large">{currentShop?.name.slice(0, 1).toUpperCase() || "店"}</div>
            <div>
              <h2>{currentShop?.name || "未选择店铺"}</h2>
              <div className="shop-meta">
                <span>店铺 ID: {currentShop?.id || "-"}</span>
                <span>关联账号: {currentShop?.clientId || "-"}</span>
                <span className={currentShop?.enabled ? "status-label ok" : "status-label warn"}>{currentShop?.enabled ? "店铺启用" : "店铺停用"}</span>
              </div>
            </div>
            <div className="shop-actions">
              <select value={shopId} onChange={(event) => setShopId(event.target.value)}>
                <option value="">选择店铺</option>
                {shops.map((shop) => (
                  <option key={shop.id} value={shop.id}>{shop.name} ({shop.clientId})</option>
                ))}
              </select>
              <button className="secondary-button" onClick={() => setShopCenterOpen(false)}>返回店铺管理</button>
              <button className="secondary-button" onClick={() => onNavigate("settings")}>店铺设置</button>
              <button className="secondary-button" onClick={() => onNavigate("jobs")}>任务列表</button>
            </div>
          </div>
          <TaskNavigation activeTab={tab} onSelect={setTab} />
        </div>
      </section>

      {tab === "overview" ? (
        <OverviewPanel
          shop={currentShop}
          templateReady={Boolean(templateProduct)}
          warehouseCount={warehouses.length}
          cachedOrderOutputRoot={orderOutputRoot}
          onSelect={setTab}
          onSettings={() => onNavigate("settings")}
          onJobs={() => onNavigate("jobs")}
        />
      ) : null}

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
                <p className="muted">先检查店铺、OSS、Excel 和 SKU 图片匹配，再提交 Ozon import。</p>
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
            previewSku={previewSku}
            setPreviewSku={setPreviewSku}
            previewTitle={previewTitle}
            setPreviewTitle={setPreviewTitle}
            previewDescription={previewDescription}
            setPreviewDescription={setPreviewDescription}
            previewImageUrls={previewImageUrls}
            setPreviewImageUrls={setPreviewImageUrls}
            previewPayload={previewPayload}
            clearPreviewPayload={() => setPreviewPayload("")}
            fetchOnlineTemplate={() => run(fetchOnlineTemplate)}
            applyJsonTemplate={() => run(async () => applyJsonTemplate())}
            saveCurrentTemplate={() => run(saveCurrentTemplate)}
            deleteCurrentTemplate={() => run(deleteCurrentTemplate)}
            clearTemplate={clearTemplate}
            previewTemplatePayload={() => run(previewTemplatePayload)}
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
                <p className="muted">按货号读取线上商品，可选择更新标题、简介、图片、视频和富内容。</p>
              </div>
              <div className="toolbar">
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
            previewSku={previewSku}
            setPreviewSku={setPreviewSku}
            previewTitle={previewTitle}
            setPreviewTitle={setPreviewTitle}
            previewDescription={previewDescription}
            setPreviewDescription={setPreviewDescription}
            previewImageUrls={previewImageUrls}
            setPreviewImageUrls={setPreviewImageUrls}
            previewPayload={previewPayload}
            clearPreviewPayload={() => setPreviewPayload("")}
            fetchOnlineTemplate={() => run(fetchOnlineTemplate)}
            applyJsonTemplate={() => run(async () => applyJsonTemplate())}
            saveCurrentTemplate={() => run(saveCurrentTemplate)}
            deleteCurrentTemplate={() => run(deleteCurrentTemplate)}
            clearTemplate={clearTemplate}
            previewTemplatePayload={() => run(previewTemplatePayload)}
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

        {inventoryMode === "products" ? (
        <>
        <section className="panel">
          <div className="section-title">
            <span className="step-dot">1</span>
            <div>
              <h2>查询商品</h2>
              <p className="muted">新手按顺序操作：加载分类，输入关键词选择分类，再查询商品。</p>
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
            <button className="secondary-button" onClick={() => run(loadCategories)}>加载分类</button>
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
          <div className="form-grid compact-form-grid">
            <div className="field">
              <label>补库存仓库</label>
              <select value={selectedWarehouseId} onChange={(event) => setSelectedWarehouseId(Number(event.target.value))}>
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
              <h2>仓库</h2>
              <button className="secondary-button" disabled={!shopId || warehousesLoading} onClick={() => loadWarehouses(shopId)}>
                {warehousesLoading ? "获取中" : "刷新仓库"}
              </button>
            </div>
            {warehouseError ? <div className="alert">{warehouseError}</div> : null}
            <div className="table-wrap">
              <table>
                <thead><tr><th>仓库名称</th><th>ID</th></tr></thead>
                <tbody>
                  {warehouses.map((warehouse) => (
                    <tr key={warehouse.warehouseId}><td>{warehouse.name}</td><td>{warehouse.warehouseId}</td></tr>
                  ))}
                  {warehouses.length === 0 ? <tr><td colSpan={2} className="muted">{warehousesLoading ? "正在获取仓库数据..." : "暂无仓库数据。"}</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
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
        </>
      ) : null}

      {tab !== "api" && tab !== "overview" ? (
        <section className="panel">
          <h2>接口结果</h2>
          <LongOutput value={result} emptyText="任务提交结果和错误会显示在这里。" maxHeight={180} onClear={() => setResult("")} />
        </section>
      ) : null}
    </div>
  );
}

function TaskNavigation(props: {
  activeTab: TabKey;
  onSelect: (tab: TabKey) => void;
}) {
  return (
    <div className="task-nav" aria-label="Ozon 任务导航">
      {TASK_TABS.map((item) => (
        <button
          key={item.key}
          className={props.activeTab === item.key ? "task-nav-item active" : "task-nav-item"}
          onClick={() => props.onSelect(item.key)}
        >
          <strong>{item.label}</strong>
          <span>{item.description}</span>
        </button>
      ))}
    </div>
  );
}

function OverviewPanel(props: {
  shop: Shop | undefined;
  templateReady: boolean;
  warehouseCount: number;
  cachedOrderOutputRoot: string;
  onSelect: (tab: TabKey) => void;
  onSettings: () => void;
  onJobs: () => void;
}) {
  const visibleTasks = TASK_TABS.filter((task) => task.key !== "overview");
  return (
    <>
      <section className="panel task-brief">
        <div>
          <h2>店铺工作台</h2>
          <p className="muted">先确认店铺，再按当前目标进入对应任务。日常高频路径是发布新品、更新商品、下载订单文件和库存价格活动。</p>
        </div>
        <div className="toolbar">
          <button className="secondary-button" onClick={props.onSettings}>店铺设置</button>
          <button className="secondary-button" onClick={props.onJobs}>任务记录</button>
        </div>
      </section>

      <section className="panel">
        <div className="overview-status-grid">
          <div className="status-block">
            <span>当前店铺</span>
            <strong>{props.shop?.name || "未选择"}</strong>
            <em>{props.shop?.enabled ? "已启用" : "需确认店铺状态"}</em>
          </div>
          <div className="status-block">
            <span>API Key</span>
            <strong>{props.shop?.apiKeyStored ? "已保存" : "未保存"}</strong>
            <em>{props.shop?.apiKeyStored ? "可执行接口任务" : "先到设置页补齐"}</em>
          </div>
          <div className="status-block">
            <span>商品模板</span>
            <strong>{props.templateReady ? "已选择" : "未选择"}</strong>
            <em>发布和更新任务会用到</em>
          </div>
          <div className="status-block">
            <span>仓库缓存</span>
            <strong>{props.warehouseCount} 个</strong>
            <em>库存操作前可在诊断页刷新</em>
          </div>
          <div className="status-block wide">
            <span>订单输出目录</span>
            <strong>{props.cachedOrderOutputRoot || "未选择"}</strong>
            <em>订单下载会记住最近一次目录</em>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>按目标开始</h2>
            <p className="muted">每张卡片对应一类工作，进入后只处理这一类任务。</p>
          </div>
        </div>
        <div className="workflow-grid">
          {visibleTasks.map((task) => (
            <article key={task.key} className="workflow-card">
              <div>
                <span className="badge neutral">{task.label}</span>
                <h3>{task.primaryAction}</h3>
                <p className="muted">{task.description}</p>
              </div>
              <button className="secondary-button" onClick={() => props.onSelect(task.key)}>进入</button>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function ShopManagementPanel(props: {
  shops: Shop[];
  selectedShopId: string;
  onSelectShop: (id: string) => void;
  onOpenShopCenter: (id: string) => void;
  onSettings: () => void;
}) {
  return (
    <>
      <section className="panel shop-manager-filter">
        <div className="panel-header">
          <div>
            <h2>店铺管理</h2>
            <p className="muted">先选择店铺卡片，进入功能中心后再操作该店铺的上架、核价、库存和活动。</p>
          </div>
          <div className="toolbar">
            <button className="primary-button" onClick={props.onSettings}>新增/编辑店铺</button>
          </div>
        </div>
      </section>

      <section className="panel shop-card-panel">
        <div className="shop-card-grid">
          {props.shops.map((shop) => (
            <article key={shop.id} className={shop.id === props.selectedShopId ? "shop-card active" : "shop-card"} onClick={() => props.onSelectShop(shop.id)}>
              <div className="shop-card-head">
                <span className="shop-avatar large">{shop.name.slice(0, 1).toUpperCase()}</span>
                <div className="shop-card-title">
                  <h3>{shop.name}</h3>
                  <span>ID: {shop.id}</span>
                  <span>账号: {shop.clientId}</span>
                </div>
                <button className="primary-button" onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenShopCenter(shop.id);
                }}>功能中心</button>
              </div>
              <div className="shop-card-status">
                <div>
                  <span>自动运行功能</span>
                  <strong>配置</strong>
                </div>
                <div>
                  <span>账号状态</span>
                  <strong className={shop.apiKeyStored ? "green-text" : "red-text"}>{shop.apiKeyStored ? "在线" : "离线"}</strong>
                </div>
                <div>
                  <span>店铺状态</span>
                  <strong className={shop.enabled ? "green-text" : "red-text"}>{shop.enabled ? "启用" : "停用"}</strong>
                </div>
              </div>
              <div className="shop-card-foot">
                <strong>正在执行的任务</strong>
                <span className="muted">暂无执行任务</span>
              </div>
            </article>
          ))}
          {props.shops.length === 0 ? (
            <div className="empty-shop-state">
              <h3>暂无店铺</h3>
              <p className="muted">先在设置里保存店铺和 Ozon API Key，再从这里进入每个店铺的功能中心。</p>
              <button className="primary-button" onClick={props.onSettings}>去配置店铺</button>
            </div>
          ) : null}
        </div>
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
          <p className="muted">商品获得 Ozon 商品 ID 后，自动生成条码、补库存并加入指定活动。关闭时保持原上架流程不变。</p>
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
            <button className="secondary-button" type="button" onClick={props.refreshWarehouses}>刷新仓库</button>
            <button className="secondary-button" type="button" onClick={props.refreshActions}>刷新活动</button>
            <span className="muted">自动处理失败会写入任务日志和结果表，不会中断后续商品上架。</span>
          </div>
        </>
      ) : null}
    </div>
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
  previewSku: string;
  setPreviewSku: (value: string) => void;
  previewTitle: string;
  setPreviewTitle: (value: string) => void;
  previewDescription: string;
  setPreviewDescription: (value: string) => void;
  previewImageUrls: string;
  setPreviewImageUrls: (value: string) => void;
  previewPayload: string;
  clearPreviewPayload: () => void;
  fetchOnlineTemplate: () => void;
  applyJsonTemplate: () => void;
  saveCurrentTemplate: () => void;
  deleteCurrentTemplate: () => void;
  clearTemplate: () => void;
  previewTemplatePayload: () => void;
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

      <div className="panel-subsection">
        <div className="panel-header">
          <h3>最终 payload 预览</h3>
          <button className="secondary-button" onClick={props.previewTemplatePayload}>生成预览</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>预览货号</label>
            <input value={props.previewSku} onChange={(event) => props.setPreviewSku(event.target.value)} />
          </div>
          <div className="field">
            <label>预览标题</label>
            <input value={props.previewTitle} onChange={(event) => props.setPreviewTitle(event.target.value)} />
          </div>
          <div className="field">
            <label>预览简介</label>
            <input value={props.previewDescription} onChange={(event) => props.setPreviewDescription(event.target.value)} />
          </div>
          <div className="field">
            <label>预览图片 URL (每行一个)</label>
            <textarea rows={3} value={props.previewImageUrls} onChange={(event) => props.setPreviewImageUrls(event.target.value)} />
          </div>
        </div>
        {props.previewPayload ? (
          <LongOutput
            value={props.previewPayload}
            emptyText="生成预览后会显示在这里。"
            maxHeight={180}
            onClear={props.clearPreviewPayload}
          />
        ) : null}
      </div>
    </section>
  );
}

function PreflightSection({ issues, onNavigate }: { issues: PreflightIssue[]; onNavigate: (page: "settings" | "jobs") => void }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>开始前预检查</h2>
      </div>
      <PreflightPanel issues={issues} onAction={(target) => {
        if (target === "settings" || target === "jobs") onNavigate(target);
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

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error:\s*/i, "").trim() || "操作失败，请查看接口结果。";
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
}) {
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
  };
  const generateBarcodes = async () => {
    if (!props.shopId) throw new Error("请先选择店铺");
    const results = [];
    for (const [index, chunk] of chunkArray(productIds, 100).entries()) {
      const data = await api.generateBarcodes(props.shopId, chunk);
      results.push({ batch: index + 1, count: chunk.length, data });
    }
    props.setResult(JSON.stringify({ batches: results.length, total: productIds.length, results }, null, 2));
  };

  return (
    <>
      <div className="operation-grid">
        <div className="operation-card">
          <strong>{props.selectedProductIds.length > 0 ? "所选商品更新库存" : "当前列表更新库存"}</strong>
          <span>有勾选时仅处理勾选商品；未勾选时处理当前列表全部商品。</span>
          <button className="primary-button" disabled={productIds.length === 0} onClick={() => updateStocks().catch((error) => props.setResult(String(error)))}>
            更新列表库存
          </button>
        </div>
        <div className="operation-card">
          <strong>{props.selectedProductIds.length > 0 ? "所选商品更新价格" : "当前列表更新价格"}</strong>
          <span>有勾选时仅处理勾选商品；未勾选时处理当前列表全部商品。</span>
          <button className="primary-button" disabled={operationProducts.length === 0} onClick={() => updatePrices().catch((error) => props.setResult(String(error)))}>
            更新列表价格
          </button>
        </div>
        <div className="operation-card">
          <strong>生成条码</strong>
          <span>有勾选时仅处理勾选商品；未勾选时处理当前列表全部商品。</span>
          <button className="secondary-button" disabled={productIds.length === 0} onClick={() => generateBarcodes().catch((error) => props.setResult(String(error)))}>
            生成条码
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
