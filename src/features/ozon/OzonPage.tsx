import { useEffect, useState } from "react";
import type { AppSettings, CategoryOption, OzonProductRow, PreflightIssue, Shop, TemplateSummary, WarehouseOption } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";
import { hasBlockingIssues, PreflightPanel } from "../../lib/PreflightPanel";

interface Props {
  shops: Shop[];
  settings: AppSettings;
  onChanged: () => void;
  onNavigate: (page: "settings" | "jobs") => void;
}

type TabKey = "upload" | "update" | "orders" | "inventory" | "api";
const PRODUCT_TEMPLATE_KIND = "product_import";
const TASK_TABS: Array<{ key: TabKey; label: string }> = [
  { key: "upload", label: "商品发布任务" },
  { key: "update", label: "商品确认任务" },
  { key: "orders", label: "订单文件下载" },
  { key: "inventory", label: "核价/库存/活动" },
  { key: "api", label: "店铺接口状态" },
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
  maxActionPrice?: string;
  minActionPrice?: string;
  status?: string;
  raw: Record<string, unknown>;
}

interface CacheEntry<T> {
  savedAt: string;
  data: T;
}

const QUERY_CACHE_PREFIX = "ozon-sjsq:query-cache:v1";

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

export function OzonPage({ shops, settings, onChanged, onNavigate }: Props) {
  const [tab, setTab] = useState<TabKey>("upload");
  const [shopId, setShopId] = useState<string>(shops.find((shop) => shop.enabled)?.id ?? shops[0]?.id ?? "");
  const [shopCenterOpen, setShopCenterOpen] = useState(false);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [warehousesLoading, setWarehousesLoading] = useState(false);
  const [warehouseError, setWarehouseError] = useState("");
  const [result, setResult] = useState("");
  const [issues, setIssues] = useState<PreflightIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const [portraitRoot, setPortraitRoot] = useState(settings.defaultOutputRoot);
  const [excelPath, setExcelPath] = useState(settings.uploadExcelPath);
  const [maxItems, setMaxItems] = useState(settings.uploadMaxItems || 100);
  const [templateVideoLinks, setTemplateVideoLinks] = useState("");
  const [updateTitle, setUpdateTitle] = useState(true);
  const [updateDescription, setUpdateDescription] = useState(true);
  const [updateImages, setUpdateImages] = useState(true);
  const [updateVideo, setUpdateVideo] = useState(false);
  const [updateRichJson, setUpdateRichJson] = useState(false);
  const [orderNumbersText, setOrderNumbersText] = useState("");
  const [orderOutputRoot, setOrderOutputRoot] = useState(settings.defaultOutputRoot);
  const [ozonSellerHarPath, setOzonSellerHarPath] = useState("/Users/a18338062216/Downloads/seller.ozon.ru.har");
  const [ozonSellerCookiePath, setOzonSellerCookiePath] = useState("");
  const [baiduCookiePath, setBaiduCookiePath] = useState("/Users/a18338062216/Documents/tool/baidu-pan-image-downloader/config.json");
  const [baiduSearchDir, setBaiduSearchDir] = useState("/");
  const [baiduRecursive, setBaiduRecursive] = useState(true);
  const [downloadMaterials, setDownloadMaterials] = useState(true);
  const [products, setProducts] = useState<OzonProductRow[]>([]);
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
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateOfferId, setTemplateOfferId] = useState("");
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
  const [actionProducts, setActionProducts] = useState<ActionProductRow[]>([]);
  const [actionProductLimit, setActionProductLimit] = useState(100);
  const [actionProductLastId, setActionProductLastId] = useState("");
  const [nextActionProductLastId, setNextActionProductLastId] = useState("");
  const [actionPrice, setActionPrice] = useState("");
  const [actionStock, setActionStock] = useState(10);

  const uploadRequest = () => ({
    shopIds: shopId ? [shopId] : [],
    portraitRoot,
    excelPath,
    templateProduct,
    maxItems: maxItems || undefined,
    uploadTemplateVideo: false,
    templateVideoLinks: templateVideoLinks ? templateVideoLinks.split("\n").map((item) => item.trim()).filter(Boolean) : [],
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
    orderNumbers: orderNumbersText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    outputRoot: orderOutputRoot,
    ozonCompanyId: currentShop?.clientId,
    ozonSellerHarPath,
    ozonSellerCookiePath,
    baiduCookiePath,
    baiduSearchDir,
    baiduRecursive,
    downloadMaterials,
  });

  const currentShop = shops.find((shop) => shop.id === shopId);

  const loadTemplates = async () => {
    const data = await api.listTemplates(PRODUCT_TEMPLATE_KIND);
    setTemplates(data);
  };

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
    try {
      await action();
    } catch (error) {
      setResult(String(error));
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
      setActionProductLastId("");
      setNextActionProductLastId("");
      return;
    }
    const cached = readQueryCache<{
      rows: ActionProductRow[];
      lastId: string;
      nextLastId: string;
    }>(id, `action-products:${actionId}`);
    setActionProducts(cached?.data.rows ?? []);
    setActionProductLastId(cached?.data.lastId ?? "");
    setNextActionProductLastId(cached?.data.nextLastId ?? "");
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
      onChanged();
      onNavigate("jobs");
    });
  };

  const submitOrderDocuments = async () => {
    await run(async () => {
      if (!shopId) throw new Error("请先选择店铺");
      if (!orderNumbersText.trim()) throw new Error("请至少输入一个订单/货件编号");
      if (!orderOutputRoot.trim()) throw new Error("请选择输出目录");
      const job = await api.startOrderDocuments(orderDocumentsRequest());
      setResult(JSON.stringify(job, null, 2));
      onChanged();
      onNavigate("jobs");
    });
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
      const rows = await api.listOzonProducts(shopId, "ALL", 100);
      const filtered = rows.filter((row) => row.hasBarcode === false);
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
    setActionProductLastId(lastId);
    setNextActionProductLastId(nextLastId);
    writeQueryCache(shopId, "selected-action", selectedActionId);
    writeQueryCache(shopId, `action-products:${selectedActionId}`, {
      rows: enrichedRows,
      lastId,
      nextLastId,
    });
    setResult(JSON.stringify(data, null, 2));
  };

  const addSelectedProductsToAction = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!selectedActionId) throw new Error("请先选择活动");
    const selectedIds = new Set(selectedProductIds);
    const selectedRows = products.filter((product) => product.productId && selectedIds.has(product.productId));
    if (selectedRows.length === 0) throw new Error("请先勾选当前商品列表中的商品");
    const productsPayload = selectedRows.map((product) => {
      const price = actionPrice.trim() || product.price;
      if (!price) throw new Error(`${product.offerId} 缺少活动价，请填写活动价`);
      return {
        product_id: product.productId,
        action_price: price,
        stock: actionStock,
      };
    });
    const data = await api.activateActionProducts(shopId, Number(selectedActionId), productsPayload);
    setResult(JSON.stringify({ total: productsPayload.length, data }, null, 2));
  };

  const removeSelectedProductsFromAction = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!selectedActionId) throw new Error("请先选择活动");
    if (selectedProductIds.length === 0) throw new Error("请先勾选当前商品列表中的商品");
    const data = await api.deactivateActionProducts(shopId, Number(selectedActionId), selectedProductIds);
    setResult(JSON.stringify({ total: selectedProductIds.length, data }, null, 2));
  };

  const applyTemplate = (payload: unknown, status: string) => {
    setTemplateProduct(payload);
    setTemplateJson(JSON.stringify(payload, null, 2));
    setTemplateStatus(status);
    setPreviewPayload("");
  };

  const fetchOnlineTemplate = async () => {
    if (!shopId) throw new Error("请先选择店铺");
    if (!templateOfferId.trim()) throw new Error("请输入模板商品货号");
    const [info, attrs] = await Promise.all([
      api.getProductInfo(shopId, [templateOfferId.trim()]),
      api.getProductAttributes(shopId, [templateOfferId.trim()]),
    ]);
    const product = firstResultItem(info);
    const attributes = firstResultItem(attrs);
    const mergedAttributes = extractAttributes(attributes, product);
    const template = {
      ...(isRecord(product) ? product : {}),
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
    setSelectedTemplateId(saved.id);
    setTemplateName(saved.name);
    await loadTemplates();
    setTemplateStatus(`模板已保存：${saved.name}`);
  };

  const selectTemplate = (id: string) => {
    setSelectedTemplateId(id);
    const selected = templates.find((template) => template.id === id);
    if (!selected) return;
    setTemplateName(selected.name);
    applyTemplate(selected.payload, `已选择保存模板：${selected.name}`);
  };

  const deleteCurrentTemplate = async () => {
    if (!selectedTemplateId) return;
    await api.deleteTemplate(selectedTemplateId);
    setSelectedTemplateId("");
    setTemplateName("");
    await loadTemplates();
    setTemplateStatus("模板已删除，当前任务未使用模板");
    setTemplateProduct(undefined);
    setTemplateJson("");
  };

  const clearTemplate = () => {
    setSelectedTemplateId("");
    setTemplateName("");
    setTemplateOfferId("");
    setTemplateProduct(undefined);
    setTemplateJson("");
    setPreviewPayload("");
    setTemplateStatus("未选择商品模板");
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
      setActionProductLastId("");
      setNextActionProductLastId("");
      setWarehouseError("请先在设置页保存店铺，并选择店铺后获取仓库。");
    }
  }, [shopId]);

  useEffect(() => {
    loadTemplates().catch((error) => setResult(String(error)));
  }, []);

  const openShopCenter = (id: string) => {
    setShopId(id);
    setTab("upload");
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
          <div className="task-tabs">
            {TASK_TABS.map((item) => (
              <button key={item.key} className={tab === item.key ? "task-tab active" : "task-tab"} onClick={() => setTab(item.key)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

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
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>订单文件下载</h2>
              <p className="muted">按 Ozon 订单/货件编号创建独立文件夹，保存标签、条码、拣货单和货号素材。</p>
            </div>
            <div className="toolbar">
              <button className="primary-button" onClick={submitOrderDocuments}>开始下载</button>
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label>订单/货件编号</label>
              <textarea
                rows={7}
                value={orderNumbersText}
                onChange={(event) => setOrderNumbersText(event.target.value)}
                placeholder={"每行一个，例如 12345678-0001-1"}
              />
            </div>
            <div className="field">
              <label>输出目录</label>
              <PathInput value={orderOutputRoot} onChange={setOrderOutputRoot} mode="dir" />
            </div>
            <div className="field">
              <label>Ozon 后台 HAR</label>
              <PathInput value={ozonSellerHarPath} onChange={setOzonSellerHarPath} mode="file" />
            </div>
            <div className="field">
              <label>Ozon 后台 Cookie</label>
              <PathInput value={ozonSellerCookiePath} onChange={setOzonSellerCookiePath} mode="file" />
            </div>
            <div className="field">
              <label>百度网盘 Cookie 配置</label>
              <PathInput value={baiduCookiePath} onChange={setBaiduCookiePath} mode="file" />
            </div>
            <div className="field">
              <label>网盘搜索目录</label>
              <input value={baiduSearchDir} onChange={(event) => setBaiduSearchDir(event.target.value)} placeholder="/" />
            </div>
          </div>
          <div className="check-grid">
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
      ) : null}

      {tab === "inventory" ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>库存/条码</h2>
              <p className="muted">可按分类查询商品，再对当前列表批量更新库存或价格。</p>
            </div>
            <div className="toolbar">
              <button className="secondary-button" onClick={() => run(loadCategories)}>加载分类</button>
              <button className="secondary-button" onClick={() => run(loadCategoryProducts)}>按分类查询</button>
              <button className="secondary-button" onClick={() => run(loadActions)}>查询活动</button>
              <button className="secondary-button" onClick={loadZeroStock}>拉取零库存</button>
              <button className="secondary-button" onClick={loadNoBarcode}>拉取无条码</button>
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
          <ActionPanel
            actions={actions}
            selectedActionId={selectedActionId}
            setSelectedActionId={(value) => {
              setSelectedActionId(value);
              writeQueryCache(shopId, "selected-action", value);
              applyCachedActionProducts(shopId, value);
            }}
            actionProducts={actionProducts}
            actionProductLimit={actionProductLimit}
            setActionProductLimit={setActionProductLimit}
            actionProductLastId={actionProductLastId}
            nextActionProductLastId={nextActionProductLastId}
            actionPrice={actionPrice}
            setActionPrice={setActionPrice}
            actionStock={actionStock}
            setActionStock={setActionStock}
            selectedProductCount={selectedProductIds.length}
            loadActions={() => run(loadActions)}
            loadActionProducts={(lastId) => run(async () => loadActionProducts(lastId))}
            addSelectedProducts={() => run(addSelectedProductsToAction)}
            removeSelectedProducts={() => run(removeSelectedProductsFromAction)}
            setResult={setResult}
          />
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
            <pre className="log-box">{result || "接口返回和错误会显示在这里。"}</pre>
          </section>
        </>
      ) : null}

      {tab !== "api" ? (
        <section className="panel">
          <h2>接口结果</h2>
          <pre className="log-box" style={{ marginTop: 12 }}>{result || "任务提交结果和错误会显示在这里。"}</pre>
        </section>
      ) : null}
    </div>
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
        {props.previewPayload ? <pre className="log-box" style={{ marginTop: 8 }}>{props.previewPayload}</pre> : null}
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

function extractNextLastId(value: unknown): string {
  if (!isRecord(value)) return "";
  const result = isRecord(value.result) ? value.result : value;
  return scalarText(result.last_id ?? result.lastId) ?? "";
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
  actionProductLimit: number;
  setActionProductLimit: (value: number) => void;
  actionProductLastId: string;
  nextActionProductLastId: string;
  actionPrice: string;
  setActionPrice: (value: string) => void;
  actionStock: number;
  setActionStock: (value: number) => void;
  selectedProductCount: number;
  loadActions: () => void;
  loadActionProducts: (lastId: string) => void;
  addSelectedProducts: () => void;
  removeSelectedProducts: () => void;
  setResult: (value: string) => void;
}) {
  return (
    <div className="panel-subsection">
      <div className="panel-header">
        <div>
          <h3>活动申报</h3>
          <p className="muted">先查询活动，选择活动后可查看已参加商品，并把当前勾选商品加入或移出活动。</p>
        </div>
        <div className="toolbar">
          <button className="secondary-button" onClick={props.loadActions}>查询活动</button>
          <button className="secondary-button" disabled={!props.selectedActionId} onClick={() => props.loadActionProducts("")}>查询活动商品</button>
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
          <label>活动商品分页数量</label>
          <input type="number" min={1} max={1000} value={props.actionProductLimit} onChange={(event) => props.setActionProductLimit(Number(event.target.value))} />
        </div>
        <div className="field">
          <label>活动价</label>
          <input value={props.actionPrice} onChange={(event) => props.setActionPrice(event.target.value)} placeholder="不填则使用商品当前售价" />
        </div>
        <div className="field">
          <label>活动库存</label>
          <input type="number" min={1} value={props.actionStock} onChange={(event) => props.setActionStock(Number(event.target.value))} />
        </div>
      </div>
      <div className="toolbar" style={{ margin: "8px 0" }}>
        <span className="muted">已勾选 {props.selectedProductCount} 个当前商品</span>
        <button className="primary-button" disabled={!props.selectedActionId || props.selectedProductCount === 0} onClick={props.addSelectedProducts}>新增参加活动</button>
        <button className="danger-button" disabled={!props.selectedActionId || props.selectedProductCount === 0} onClick={props.removeSelectedProducts}>删除参加活动</button>
        <button className="secondary-button" disabled={!props.nextActionProductLastId} onClick={() => props.loadActionProducts(props.nextActionProductLastId)}>下一页活动商品</button>
        {props.actionProductLastId ? <button className="secondary-button" onClick={() => props.loadActionProducts("")}>回到第一页活动商品</button> : null}
      </div>
      <div className="table-wrap compact-table">
        <table>
          <thead>
            <tr><th>商品信息</th><th>售价</th><th>活动价</th><th>活动库存</th><th>状态</th><th>原始字段</th></tr>
          </thead>
          <tbody>
            {props.actionProducts.map((product, index) => (
              <tr key={`${product.productId ?? product.offerId}-${index}`}>
                <td>
                  <div className="product-cell">
                    {imageUrlFrom(product.raw) || product.primaryImage ? (
                      <span className="product-thumb">
                        <img
                          src={product.primaryImage || imageUrlFrom(product.raw)}
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
                      {product.productUrl || productUrlFrom(product.raw) ? (
                        <button
                          className="product-title-link"
                          type="button"
                          onClick={() => {
                            const url = product.productUrl || productUrlFrom(product.raw);
                            if (url) api.openUrl(url).catch((error) => props.setResult(String(error)));
                          }}
                        >
                          {product.name || "未返回商品标题"}
                        </button>
                      ) : (
                        <strong>{product.name || "未返回商品标题"}</strong>
                      )}
                      <span>货号: {product.offerId || "未返回"}</span>
                      <span>商品 ID: {product.productId ?? "-"}</span>
                    </div>
                  </div>
                </td>
                <td>{[product.price, product.currencyCode].filter(Boolean).join(" ") || "-"}</td>
                <td>
                  <div>{product.actionPrice || "-"}</div>
                  {(product.minActionPrice || product.maxActionPrice) ? (
                    <div className="muted">范围 {product.minActionPrice || "-"} - {product.maxActionPrice || "-"}</div>
                  ) : null}
                </td>
                <td>{product.stock ?? "-"}</td>
                <td>{product.status || "-"}</td>
                <td>
                  <details>
                    <summary>查看</summary>
                    <pre className="inline-json">{JSON.stringify(product.raw, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
            {props.actionProducts.length === 0 ? <tr><td colSpan={6} className="muted">选择活动后可查询当前活动已参加商品。</td></tr> : null}
          </tbody>
        </table>
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
  const productIds = props.products.map((row) => row.productId).filter((id): id is number => typeof id === "number");
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
    const prices = props.products.map((product) => {
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
      <div className="toolbar" style={{ margin: "8px 0" }}>
        <button className="primary-button" disabled={productIds.length === 0} onClick={() => updateStocks().catch((error) => props.setResult(String(error)))}>
          给当前列表更新库存
        </button>
        <button className="primary-button" disabled={props.products.length === 0} onClick={() => updatePrices().catch((error) => props.setResult(String(error)))}>
          给当前列表更新价格
        </button>
        <button className="secondary-button" disabled={productIds.length === 0} onClick={() => generateBarcodes().catch((error) => props.setResult(String(error)))}>
          给列表商品生成条码
        </button>
        <span className="muted">当前页显示 {pageRows.length} 条，已勾选 {props.selectedProductIds.length} 个</span>
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
