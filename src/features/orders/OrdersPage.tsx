import { Download, PackageCheck, RefreshCw, Search, Truck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, OrderPostingRow, OrderShippingLabelAssignment, Shop } from "@shared/types";
import { api } from "../../lib/api";
import { createCloudClient, getCloudToken } from "../../lib/cloudApi";
import { LongOutput } from "../../lib/LongOutput";
import { PathInput } from "../../lib/PathInput";
import { parseOrderNumbers } from "../ozon/orderUtils";
import { isLatestOrderRequest, resolveStoredOrderQuery } from "./orderQueryUtils";

interface Props {
  shops: Shop[];
  settings: AppSettings;
  onChanged: () => void;
  onNavigate: (page: "jobs") => void;
}

const orderStatusTabs = [
  { key: "", label: "全部" },
  { key: "awaiting_packaging", label: "等待备货" },
  { key: "awaiting_deliver", label: "等待发运" },
  { key: "delivering", label: "运输中" },
  { key: "delivered", label: "已签收" },
  { key: "cancelled", label: "已取消" },
];

const syncStatusOptions = orderStatusTabs.filter((tab) => tab.key);
const ORDER_DOCUMENTS_DRAFT_KEY = "ozon-sjsq:order-documents-draft:v1";
const AUTO_ORDER_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const ORDER_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

interface OrderDocumentsDraft {
  orderOutputRoot?: string;
  baiduSearchDir?: string;
  baiduRecursive?: boolean;
  downloadMaterials?: boolean;
  selectedShopIds?: string[];
  manualShopId?: string;
  cookieShopId?: string;
  dateFrom?: string;
  dateTo?: string;
  syncStatus?: string;
  statusFilter?: string;
  keyword?: string;
  limit?: number;
  pageSize?: number;
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

function writeOrderDocumentsDraftPatch(patch: OrderDocumentsDraft) {
  if (typeof window === "undefined") return;
  const next = {
    ...readOrderDocumentsDraft(),
    ...patch,
  };
  window.localStorage.setItem(ORDER_DOCUMENTS_DRAFT_KEY, JSON.stringify(next));
}

function dateInputValue(daysAgo: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function restoreShopIds(savedIds: string[] | undefined, activeShops: Shop[]) {
  const activeIds = new Set(activeShops.map((shop) => shop.id));
  const restored = Array.from(new Set((savedIds ?? []).filter((id) => activeIds.has(id))));
  return restored.length > 0 ? restored : activeShops.map((shop) => shop.id);
}

function restoreShopId(savedId: string | undefined, activeShops: Shop[]) {
  return activeShops.some((shop) => shop.id === savedId) ? savedId! : activeShops[0]?.id ?? "";
}

function restoreLimit(value: unknown) {
  const parsed = Number(value ?? 1000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
}

function restoreOrderPageSize(value: unknown) {
  const parsed = Number(value ?? 10);
  return ORDER_PAGE_SIZE_OPTIONS.includes(parsed as typeof ORDER_PAGE_SIZE_OPTIONS[number]) ? parsed : 10;
}

function parseShippingLabelUrls(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function OrdersPage({ shops, settings, onChanged, onNavigate }: Props) {
  const savedOrderDraft = useMemo(() => readOrderDocumentsDraft(), []);
  const activeShops = useMemo(() => shops.filter((shop) => shop.enabled), [shops]);
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>(() => restoreShopIds(savedOrderDraft.selectedShopIds, activeShops));
  const [dateFrom, setDateFrom] = useState(savedOrderDraft.dateFrom || dateInputValue(30));
  const [dateTo, setDateTo] = useState(savedOrderDraft.dateTo || dateInputValue(0));
  const [syncStatus, setSyncStatus] = useState(savedOrderDraft.syncStatus || "");
  const [limit, setLimit] = useState(restoreLimit(savedOrderDraft.limit));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => restoreOrderPageSize(savedOrderDraft.pageSize));
  const [statusFilter, setStatusFilter] = useState(savedOrderDraft.statusFilter || "");
  const [keyword, setKeyword] = useState(savedOrderDraft.keyword || "");
  const [rows, setRows] = useState<OrderPostingRow[]>([]);
  const [summaryRows, setSummaryRows] = useState<OrderPostingRow[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [shippingPostingKey, setShippingPostingKey] = useState("");
  const [shippingLabelRows, setShippingLabelRows] = useState<OrderPostingRow[]>([]);
  const [shippingLabelText, setShippingLabelText] = useState("");
  const [shippingLabelError, setShippingLabelError] = useState("");
  const [submittingShippingLabels, setSubmittingShippingLabels] = useState(false);
  const [outputRoot, setOutputRoot] = useState(savedOrderDraft.orderOutputRoot ?? settings.defaultOutputRoot);
  const [manualShopId, setManualShopId] = useState(() => restoreShopId(savedOrderDraft.manualShopId, activeShops));
  const [manualOrdersText, setManualOrdersText] = useState("");
  const [cookieShopId, setCookieShopId] = useState(() => restoreShopId(savedOrderDraft.cookieShopId, activeShops));
  const [sellerCookie, setSellerCookie] = useState("");
  const [downloadMaterials, setDownloadMaterials] = useState(savedOrderDraft.downloadMaterials ?? true);
  const [baiduCookie, setBaiduCookie] = useState(settings.baiduCookie);
  const [baiduSearchDir, setBaiduSearchDir] = useState(savedOrderDraft.baiduSearchDir ?? "/");
  const [baiduRecursive, setBaiduRecursive] = useState(savedOrderDraft.baiduRecursive ?? true);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const latestSavedOrderRequestId = useRef(0);

  useEffect(() => {
    if (activeShops.length === 0) {
      return;
    }
    const activeIds = new Set(activeShops.map((shop) => shop.id));
    const validSelectedShopIds = selectedShopIds.filter((shopId) => activeIds.has(shopId));
    if (
      validSelectedShopIds.length !== selectedShopIds.length
      || validSelectedShopIds.length === 0
    ) {
      setSelectedShopIds(validSelectedShopIds.length > 0 ? validSelectedShopIds : restoreShopIds(savedOrderDraft.selectedShopIds, activeShops));
    }
    if (!manualShopId || !activeIds.has(manualShopId)) setManualShopId(restoreShopId(savedOrderDraft.manualShopId, activeShops));
    if (!cookieShopId || !activeIds.has(cookieShopId)) setCookieShopId(restoreShopId(savedOrderDraft.cookieShopId, activeShops));
  }, [activeShops, selectedShopIds, manualShopId, cookieShopId, savedOrderDraft]);

  useEffect(() => {
    loadSavedOrders().catch((error) => setResult(readableError(error)));
  }, []);

  useEffect(() => {
    if (activeShops.length === 0) return undefined;
    let disposed = false;
    const run = () => {
      autoSyncRecentOrders(() => disposed).catch((error) => {
        if (!disposed) {
          setResult((current) => [current, `自动同步订单失败：${readableError(error)}`].filter(Boolean).join("\n"));
        }
      });
    };
    run();
    const timer = window.setInterval(run, AUTO_ORDER_SYNC_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [settings.cloudApiBaseUrl, activeShops.map((shop) => shop.id).join("|")]);

  useEffect(() => {
    writeOrderDocumentsDraftPatch({
      orderOutputRoot: outputRoot,
      baiduSearchDir,
      baiduRecursive,
      downloadMaterials,
      selectedShopIds,
      manualShopId,
      cookieShopId,
      dateFrom,
      dateTo,
      syncStatus,
      statusFilter,
      keyword,
      limit,
      pageSize,
    });
  }, [
    outputRoot,
    baiduSearchDir,
    baiduRecursive,
    downloadMaterials,
    selectedShopIds,
    manualShopId,
    cookieShopId,
    dateFrom,
    dateTo,
    syncStatus,
    statusFilter,
    keyword,
    limit,
    pageSize,
  ]);

  const selectedRows = rows.filter((row) => selectedKeys.includes(rowKey(row)));
  const statusCounts = useMemo(() => countByStatus(summaryRows), [summaryRows]);
  const totals = useMemo(() => summarizeOrders(rows), [rows]);
  const selectedTotals = useMemo(() => summarizeOrders(selectedRows), [selectedRows]);
  const shopById = useMemo(() => new Map(shops.map((shop) => [shop.id, shop])), [shops]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, rows.length);
  const pagedRows = rows.slice(pageStart, pageEnd);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const toggleShop = (shopId: string, checked: boolean) => {
    setSelectedShopIds((current) => checked ? Array.from(new Set([...current, shopId])) : current.filter((id) => id !== shopId));
  };

  const uploadSavedOrderRowsToCloud = (nextRows: OrderPostingRow[], shopIds: string[], requestId: number) => {
    if (!getCloudToken() || nextRows.length === 0) {
      return;
    }
    const targetShopIds = new Set(shopIds);
    const targetShops = activeShops.filter((shop) => targetShopIds.has(shop.id));
    if (targetShops.length === 0) {
      return;
    }
    syncCloudOrderPostings(settings.cloudApiBaseUrl, targetShops, nextRows)
      .then((synced) => {
        if (synced > 0 && isLatestOrderRequest(requestId, latestSavedOrderRequestId.current)) {
          setMessage((current) => `${current} 管理端已补传 ${synced} 个历史订单。`);
        }
      })
      .catch((error) => {
        if (isLatestOrderRequest(requestId, latestSavedOrderRequestId.current)) {
          setResult((current) => [current, `历史订单同步到管理端失败：${readableError(error)}`].filter(Boolean).join("\n"));
        }
      });
  };

  const loadSavedOrders = async (
    overrides: { status?: string; keyword?: string; shopIds?: string[] } = {},
    options: { syncCloud?: boolean } = {},
  ) => {
    const requestId = latestSavedOrderRequestId.current + 1;
    latestSavedOrderRequestId.current = requestId;
    const query = resolveStoredOrderQuery({
      currentStatus: statusFilter,
      shopIds: overrides.shopIds ?? selectedShopIds,
      keyword: overrides.keyword ?? keyword,
      limit,
      ...(Object.prototype.hasOwnProperty.call(overrides, "status") ? { status: overrides.status } : {}),
    });
    const summaryQuery = { ...query, status: undefined };
    setLoading(true);
    setMessage("");
    try {
      const [nextRows, nextSummaryRows] = await Promise.all([
        api.listSavedOrderPostings(query),
        api.listSavedOrderPostings(summaryQuery),
      ]);
      if (!isLatestOrderRequest(requestId, latestSavedOrderRequestId.current)) return false;
      setRows(sortRows(nextRows));
      setPage(1);
      setSummaryRows(nextSummaryRows);
      setSelectedKeys([]);
      setMessage(`已加载本地历史订单 ${nextRows.length} 个，销售额 ${formatMoney(totalSales(nextRows))}。`);
      if (options.syncCloud !== false) {
        uploadSavedOrderRowsToCloud(nextRows, query.shopIds ?? [], requestId);
      }
      return true;
    } catch (error) {
      if (isLatestOrderRequest(requestId, latestSavedOrderRequestId.current)) throw error;
      return false;
    } finally {
      if (isLatestOrderRequest(requestId, latestSavedOrderRequestId.current)) {
        setLoading(false);
      }
    }
  };

  const syncOrders = async () => {
    if (selectedShopIds.length === 0) throw new Error("请至少选择一个店铺");
    if (!dateFrom || !dateTo) throw new Error("请选择同步日期");
    if (dateFrom > dateTo) throw new Error("开始日期不能晚于结束日期");
    setLoading(true);
    setMessage("");
    setResult("");
    try {
      const targetShops = activeShops.filter((shop) => selectedShopIds.includes(shop.id));
      const settled = await Promise.allSettled(targetShops.map((shop) => api.listOrderPostings({
        shopId: shop.id,
        dateFrom,
        dateTo,
        status: syncStatus || undefined,
        limit,
      })));
      const syncedRows: OrderPostingRow[] = [];
      const errors: string[] = [];
      const summaryLines: string[] = [];
      settled.forEach((item, index) => {
        const shop = targetShops[index];
        if (item.status === "fulfilled") {
          const shopRows = item.value.map((row) => ({
            ...row,
            shopId: row.shopId ?? shop.id,
            shopName: row.shopName ?? shop.name,
          }));
          syncedRows.push(...shopRows);
          const fbsCount = shopRows.filter((row) => row.postingKind === "fbs").length;
          const fboCount = shopRows.filter((row) => row.postingKind === "fbo").length;
          summaryLines.push(`${shop.name}: 同步 ${shopRows.length} 个订单（FBS ${fbsCount} / FBO ${fboCount}）`);
        } else {
          errors.push(`${shop.name}: ${readableError(item.reason)}`);
        }
      });
      const loaded = await loadSavedOrders({}, { syncCloud: false });
      if (!loaded) return;
      setMessage(`已同步 ${syncedRows.length} 个订单到本地历史，销售额 ${formatMoney(totalSales(syncedRows))}。`);
      setResult([...summaryLines, ...errors.map((error) => `失败：${error}`)].join("\n"));
      syncCloudOrderPostings(settings.cloudApiBaseUrl, targetShops, syncedRows)
        .then((synced) => {
          if (synced > 0) {
            setMessage((current) => `${current} 管理端已更新 ${synced} 个订单。`);
          }
        })
        .catch((error) => {
          setResult((current) => [current, `订单同步到管理端失败：${readableError(error)}`].filter(Boolean).join("\n"));
        });
      syncOrderSalesSignals(settings.cloudApiBaseUrl, targetShops, syncedRows)
        .then((synced) => {
          if (synced > 0) {
            setMessage(`已同步 ${syncedRows.length} 个订单到本地历史；已更新 ${synced} 个货号信号用于精品图库。`);
          }
        })
        .catch((error) => {
          setResult((current) => [current, `精品图库信号同步失败：${readableError(error)}`].filter(Boolean).join("\n"));
        });
    } finally {
      setLoading(false);
    }
  };

  const autoSyncRecentOrders = async (isDisposed: () => boolean) => {
    const autoDateFrom = dateInputValue(30);
    const autoDateTo = dateInputValue(0);
    const settled = await Promise.allSettled(activeShops.map((shop) => api.listOrderPostings({
      shopId: shop.id,
      dateFrom: autoDateFrom,
      dateTo: autoDateTo,
      limit: 1000,
    })));
    if (isDisposed()) return;
    const syncedRows: OrderPostingRow[] = [];
    settled.forEach((item, index) => {
      const shop = activeShops[index];
      if (item.status === "fulfilled") {
        syncedRows.push(...item.value.map((row) => ({
          ...row,
          shopId: row.shopId ?? shop.id,
          shopName: row.shopName ?? shop.name,
        })));
      }
    });
    if (syncedRows.length > 0) {
      await syncCloudOrderPostings(settings.cloudApiBaseUrl, activeShops, syncedRows);
      await syncOrderSalesSignals(settings.cloudApiBaseUrl, activeShops, syncedRows).catch(() => 0);
    }
    if (!isDisposed()) {
      await loadSavedOrders({}, { syncCloud: false });
    }
  };

  const shipOrder = async (row: OrderPostingRow) => {
    if (!row.shopId) throw new Error("该订单缺少店铺 ID，无法备货");
    const key = rowKey(row);
    setShippingPostingKey(key);
    setResult("");
    try {
      const updated = await api.shipOrderPosting(row.shopId, row.postingNumber);
      setRows((current) => sortRows(current.map((item) => rowKey(item) === key ? updated : item)));
      setMessage(`${row.postingNumber} 已提交备货，Ozon 状态已刷新为 ${statusText(updated.status)}。`);
    } catch (error) {
      setResult(readableError(error));
    } finally {
      setShippingPostingKey("");
    }
  };

  const saveSellerCookie = async () => {
    if (!cookieShopId) throw new Error("请先选择保存到哪个店铺");
    if (!sellerCookie.trim()) throw new Error("请粘贴这个店铺自己的 Ozon 后台 Cookie");
    const saved = await api.saveShopSellerCookie(cookieShopId, sellerCookie);
    setSellerCookie("");
    setMessage(`${saved.name} 的 Ozon 后台 Cookie 已保存。`);
    onChanged();
  };

  const openShippingLabelDialog = (rowsToDownload: OrderPostingRow[]) => {
    if (rowsToDownload.length === 0) throw new Error("请先勾选要下载的订单");
    if (!outputRoot.trim()) throw new Error("请选择输出目录");
    if (rowsToDownload.some((row) => !row.shopId)) throw new Error("选中的订单缺少店铺信息");
    setShippingLabelRows(rowsToDownload);
    setShippingLabelText("");
    setShippingLabelError("");
  };

  const downloadRows = async (rowsToDownload: OrderPostingRow[], assignments: OrderShippingLabelAssignment[]) => {
    try {
      await api.reserveOrderShippingLabels(assignments);
    } catch (error) {
      if (!isUnsupportedLocalAssistantCommand(error, "reserve_order_shipping_labels")) {
        throw error;
      }
    }
    const byShop = new Map<string, OrderPostingRow[]>();
    for (const row of rowsToDownload) {
      if (!row.shopId) continue;
      byShop.set(row.shopId, [...(byShop.get(row.shopId) ?? []), row]);
    }
    const jobs = [];
    for (const [shopId, shopRows] of byShop) {
      const shop = shops.find((item) => item.id === shopId);
      if (!shop) continue;
      const shopOrderNumbers = new Set(shopRows.map((row) => row.postingNumber));
      const job = await api.startOrderDocuments({
        shopId,
        orderNumbers: shopRows.map((row) => row.postingNumber),
        outputRoot,
        ozonCompanyId: shop.clientId,
        ozonSellerCookiePath: "",
        baiduCookie,
        baiduSearchDir,
        baiduRecursive,
        downloadMaterials,
        shippingLabels: assignments
          .filter((item) => item.shopId === shopId && shopOrderNumbers.has(item.orderNumber))
          .map(({ orderNumber, url }) => ({ orderNumber, url })),
      });
      jobs.push(job);
    }
    setMessage(`已按店铺提交 ${jobs.length} 个订单下载任务，每个订单已绑定唯一物流贴单。`);
    setResult(JSON.stringify(jobs, null, 2));
    onChanged();
    onNavigate("jobs");
  };

  const confirmShippingLabels = async () => {
    const urls = parseShippingLabelUrls(shippingLabelText);
    if (urls.length !== shippingLabelRows.length) {
      throw new Error(`物流贴单地址数量必须等于订单数量：订单 ${shippingLabelRows.length} 个，地址 ${urls.length} 个`);
    }
    if (new Set(urls).size !== urls.length) {
      throw new Error("同一个物流贴单地址不能重复使用");
    }
    for (const url of urls) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`物流贴单地址格式不正确：${url}`);
      }
      if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.pathname.toLowerCase().endsWith(".pdf")) {
        throw new Error(`物流贴单地址必须是 HTTP/HTTPS PDF：${url}`);
      }
    }
    const assignments = shippingLabelRows.map((row, index) => ({
      shopId: row.shopId!,
      orderNumber: row.postingNumber,
      url: urls[index],
    }));
    setSubmittingShippingLabels(true);
    setShippingLabelError("");
    try {
      await downloadRows(shippingLabelRows, assignments);
      setShippingLabelRows([]);
      setShippingLabelText("");
    } finally {
      setSubmittingShippingLabels(false);
    }
  };

  const downloadManual = () => {
    const orderNumbers = parseOrderNumbers(manualOrdersText);
    if (!manualShopId) throw new Error("请选择店铺");
    if (orderNumbers.length === 0) throw new Error("请输入订单/货件编号");
    const shop = shops.find((item) => item.id === manualShopId);
    openShippingLabelDialog(orderNumbers.map((postingNumber) => ({
      shopId: manualShopId,
      shopName: shop?.name,
      postingNumber,
      productsCount: 0,
      offerIds: [],
    })));
  };

  const toggleRow = (row: OrderPostingRow, checked: boolean) => {
    const key = rowKey(row);
    setSelectedKeys((current) => checked ? Array.from(new Set([...current, key])) : current.filter((item) => item !== key));
  };

  const toggleAllRows = (checked: boolean) => {
    setSelectedKeys(checked ? rows.map(rowKey) : []);
  };

  const applyStatusFilter = (nextStatus: string) => {
    setStatusFilter(nextStatus);
    loadSavedOrders({ status: nextStatus }).catch((error) => setResult(readableError(error)));
  };

  return (
    <div className="content-grid order-page">
      {message ? <section className="panel"><span className="badge">{message}</span></section> : null}

      <section className="panel order-toolbar-panel">
        <div className="panel-header">
          <div>
            <h2>订单历史工作台</h2>
            <p className="muted">同步会拉取 Ozon 最新状态并写入本地历史；列表默认读取本地已保存订单。</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" onClick={() => loadSavedOrders().catch((error) => setResult(readableError(error)))} disabled={loading}>
              <Search size={15} /> 查询历史
            </button>
            <button className="primary-button" onClick={() => syncOrders().catch((error) => setResult(readableError(error)))} disabled={loading}>
              <RefreshCw size={15} className={loading ? "spin-icon" : undefined} /> 同步 Ozon 订单
            </button>
            <button className="secondary-button" onClick={() => { try { openShippingLabelDialog(selectedRows); } catch (error) { setResult(readableError(error)); } }} disabled={selectedRows.length === 0}>
              <Download size={15} /> 下载勾选 ({selectedRows.length})
            </button>
          </div>
        </div>

        <div className="order-status-tabs">
          {orderStatusTabs.map((tab) => (
            <button key={tab.key || "all"} className={statusFilter === tab.key ? "active" : ""} onClick={() => applyStatusFilter(tab.key)}>
              {tab.label}
              <span>{tab.key ? statusCounts.get(tab.key) ?? 0 : summaryRows.length}</span>
            </button>
          ))}
        </div>

        <div className="form-grid compact-form-grid order-filter-grid">
          <div className="field">
            <label>同步开始日期</label>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </div>
          <div className="field">
            <label>同步结束日期</label>
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </div>
          <div className="field">
            <label>同步状态</label>
            <select value={syncStatus} onChange={(event) => setSyncStatus(event.target.value)}>
              <option value="">全部状态</option>
              {syncStatusOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>关键词</label>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") loadSavedOrders().catch((error) => setResult(readableError(error)));
            }} placeholder="货件号、货号、商品名、跟踪号" />
          </div>
          <div className="field">
            <label>最多显示</label>
            <input type="number" min={1} max={5000} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
          </div>
        </div>

        <div className="check-grid compact-checks">
          {activeShops.map((shop) => (
            <label className="check-card" key={shop.id}>
              <input type="checkbox" checked={selectedShopIds.includes(shop.id)} onChange={(event) => toggleShop(shop.id, event.target.checked)} />
              {shop.name}
            </label>
          ))}
        </div>

        <div className="overview-status-grid">
          <div className="status-block">
            <span>历史订单</span>
            <strong>{rows.length}</strong>
            <em>当前筛选结果</em>
          </div>
          <div className="status-block">
            <span>销售额</span>
            <strong>{formatMoney(totals)}</strong>
            <em>按订单商品价格求和</em>
          </div>
          <div className="status-block">
            <span>等待备货</span>
            <strong>{statusCounts.get("awaiting_packaging") ?? 0}</strong>
            <em>可点击备货</em>
          </div>
          <div className="status-block">
            <span>运输中</span>
            <strong>{statusCounts.get("delivering") ?? 0}</strong>
            <em>同步后自动更新</em>
          </div>
          <div className="status-block">
            <span>已勾选</span>
            <strong>{selectedRows.length}</strong>
            <em>{formatMoney(selectedTotals)}</em>
          </div>
        </div>
      </section>

      <section className="panel order-list-panel">
        <div className="panel-header">
          <div>
            <h2>订单列表</h2>
            <p className="muted">状态保持 Ozon 原状态，同时显示中文含义；等待备货支持直接提交备货。</p>
          </div>
          <button className="secondary-button" onClick={() => toggleAllRows(selectedKeys.length !== rows.length)}>
            {selectedKeys.length === rows.length && rows.length > 0 ? "取消全选" : "全选"}
          </button>
        </div>
        <div className="table-wrap order-table-wrap">
          <table className="order-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={rows.length > 0 && selectedKeys.length === rows.length} onChange={(event) => toggleAllRows(event.target.checked)} /></th>
                <th>货件编号</th>
                <th>状态</th>
                <th>已接收</th>
                <th>发运日期</th>
                <th>照片</th>
                <th>数量、货号 / 商品名称</th>
                <th>追踪号码</th>
                <th>价格</th>
                <th>仓库</th>
                <th>下载状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row) => {
                const key = rowKey(row);
                const products = row.products?.length ? row.products : [{ offerId: row.offerIds[0] || "-", quantity: row.productsCount || 1, name: "" }];
                return (
                  <tr key={key}>
                    <td><input type="checkbox" checked={selectedKeys.includes(key)} onChange={(event) => toggleRow(row, event.target.checked)} /></td>
                    <td>
                      <strong>{row.postingNumber}</strong>
                      <div className="muted">{row.shopName || row.shopId || "-"}</div>
                      {row.postingKind ? <div className="muted">{row.postingKind.toUpperCase()}</div> : null}
                    </td>
                    <td><span className={`order-status-badge status-${statusClass(row.status)}`}>{statusText(row.status)}</span></td>
                    <td>{formatDateTime(row.inProcessAt)}</td>
                    <td>{formatDateTime(row.shipmentDate)}</td>
                    <td>
                      <OrderImage row={row} />
                    </td>
                    <td>
                      <div className="order-products-cell">
                        {products.slice(0, 3).map((product, index) => (
                          <div key={`${product.offerId}-${index}`}>
                            <strong>{product.quantity || 1}个 {product.offerId}</strong>
                            <span>{product.name || "未返回商品名称"}</span>
                          </div>
                        ))}
                        {products.length > 3 ? <em>还有 {products.length - 3} 个商品</em> : null}
                      </div>
                    </td>
                    <td>{row.trackingNumber || row.orderNumber || row.orderId || "-"}</td>
                    <td>{formatMoney(row.salesAmount, row.currencyCode)}</td>
                    <td>{row.warehouseName || shopById.get(row.shopId || "")?.name || "-"}</td>
                    <td>
                      {row.downloadedAt ? (
                        <span className="order-download-status is-downloaded" title={row.downloadOutputPath || ""}>
                          已下载<br /><small>{formatDateTime(row.downloadedAt)}</small>
                        </span>
                      ) : <span className="order-download-status">未下载</span>}
                    </td>
                    <td>
                      <div className="toolbar">
                        {row.status === "awaiting_packaging" ? (
                          <button className="primary-button compact-action" disabled={shippingPostingKey === key} onClick={() => shipOrder(row)}>
                            {shippingPostingKey === key ? <RefreshCw size={14} className="spin-icon" /> : <PackageCheck size={14} />} 备货
                          </button>
                        ) : row.status === "delivering" ? (
                          <span className="status-pill"><Truck size={14} /> 运输中</span>
                        ) : null}
                        <button className="secondary-button compact-action" onClick={() => { try { openShippingLabelDialog([row]); } catch (error) { setResult(readableError(error)); } }}>
                          <Download size={14} /> 文件
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? <tr><td colSpan={12} className="muted">暂无历史订单。请先点击“同步 Ozon 订单”。</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="pagination-bar order-pagination-bar">
          <span>{rows.length > 0 ? `显示 ${pageStart + 1}-${pageEnd}，共 ${rows.length} 条` : "共 0 条"}</span>
          <div className="toolbar">
            <label className="order-page-size">
              每页
              <select
                aria-label="每页订单数"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {ORDER_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}
              </select>
            </label>
            <button className="secondary-button" aria-label="上一页订单" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            <span>第 {currentPage} / {pageCount} 页</span>
            <button className="secondary-button" aria-label="下一页订单" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>下载与 Cookie 设置</h2>
            <p className="muted">Ozon 后台 Cookie 按店铺分别保存；订单标签和文件下载仍使用这里的设置。</p>
          </div>
          <button className="secondary-button" onClick={() => saveSellerCookie().catch((error) => setResult(readableError(error)))}>保存当前店铺 Cookie</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>保存 Cookie 到店铺</label>
            <select value={cookieShopId} onChange={(event) => setCookieShopId(event.target.value)}>
              <option value="">选择店铺</option>
              {activeShops.map((shop) => (
                <option key={shop.id} value={shop.id}>{shop.name} {shop.ozonSellerCookieStored ? "(已保存)" : "(未保存)"}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>输出目录</label>
            <PathInput value={outputRoot} onChange={setOutputRoot} mode="dir" />
          </div>
          <div className="field">
            <label>Ozon 后台 Cookie</label>
            <textarea rows={5} value={sellerCookie} onChange={(event) => setSellerCookie(event.target.value)} placeholder="只粘贴所选店铺自己的 Cookie、Cookie: ... 或 Copy as cURL" />
          </div>
          <div className="field">
            <label>百度网盘 Cookie</label>
            <textarea rows={5} value={baiduCookie} onChange={(event) => setBaiduCookie(event.target.value)} placeholder="可选，下载货号素材时需要 BDUSS" />
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

      <section className="panel">
        <div className="panel-header">
          <h2>手动下载订单文件</h2>
          <button className="primary-button" onClick={() => { try { downloadManual(); } catch (error) { setResult(readableError(error)); } }}>下载输入编号</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>店铺</label>
            <select value={manualShopId} onChange={(event) => setManualShopId(event.target.value)}>
              <option value="">选择店铺</option>
              {activeShops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>订单/货件编号</label>
            <textarea rows={5} value={manualOrdersText} onChange={(event) => setManualOrdersText(event.target.value)} placeholder="每行一个，或用逗号/空格分隔" />
          </div>
        </div>
      </section>

      {shippingLabelRows.length > 0 ? (
        <div className="modal-backdrop" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget && !submittingShippingLabels) setShippingLabelRows([]);
        }}>
          <section className="modal-panel order-shipping-label-dialog" role="dialog" aria-modal="true" aria-label="填写物流贴单地址">
            <div className="panel-header">
              <div>
                <h2>填写物流贴单地址</h2>
                <p className="muted">按下方订单顺序每行粘贴一个 PDF 地址。地址数量必须一致，并且不能与其他订单重复使用。</p>
              </div>
            </div>
            <div className="order-shipping-label-grid">
              <div className="order-shipping-label-orders">
                {shippingLabelRows.map((row, index) => (
                  <div key={rowKey(row)}><strong>{index + 1}. {row.postingNumber}</strong><span>{row.shopName || row.shopId}</span></div>
                ))}
              </div>
              <div className="field">
                <label>物流贴单 PDF 地址（共 {shippingLabelRows.length} 个）</label>
                <textarea rows={Math.min(16, Math.max(6, shippingLabelRows.length + 1))} value={shippingLabelText} onChange={(event) => { setShippingLabelText(event.target.value); setShippingLabelError(""); }} placeholder="每行粘贴一个 PDF 地址，顺序与左侧订单一致" />
                <span className="muted">已填写 {parseShippingLabelUrls(shippingLabelText).length} / {shippingLabelRows.length}</span>
              </div>
            </div>
            {shippingLabelError ? <div className="error-banner">{shippingLabelError}</div> : null}
            <div className="modal-actions">
              <button className="secondary-button" disabled={submittingShippingLabels} onClick={() => setShippingLabelRows([])}>取消</button>
              <button className="primary-button" disabled={submittingShippingLabels} onClick={() => confirmShippingLabels().catch((error) => setShippingLabelError(readableError(error)))}>
                {submittingShippingLabels ? "正在提交" : "确认并下载"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {result ? (
        <section className="panel">
          <LongOutput value={result} emptyText="接口结果会显示在这里。" label="接口结果" maxHeight={180} onClear={() => setResult("")} />
        </section>
      ) : null}
    </div>
  );
}

function OrderImage({ row }: { row: OrderPostingRow }) {
  const imageUrl = row.imageUrl || row.products?.find((product) => product.imageUrl)?.imageUrl;
  if (!imageUrl) return <span className="order-thumb-empty">无图</span>;
  return (
    <span className="order-thumb">
      <img
        src={imageUrl}
        alt={row.offerIds[0] || row.postingNumber}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
      />
      <span>无图</span>
    </span>
  );
}

function rowKey(row: OrderPostingRow) {
  return `${row.shopId || ""}::${row.postingNumber}`;
}

function summarizeOrders(rows: OrderPostingRow[]) {
  return rows.reduce((sum, row) => sum + (row.salesAmount ?? 0), 0);
}

function totalSales(rows: OrderPostingRow[]) {
  return summarizeOrders(rows);
}

function countByStatus(rows: OrderPostingRow[]) {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const status = row.status || "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  });
  return counts;
}

function sortRows(rows: OrderPostingRow[]) {
  return [...rows].sort((left, right) => rowTime(right) - rowTime(left));
}

function rowTime(row: OrderPostingRow) {
  return new Date(row.inProcessAt || row.shipmentDate || row.syncedAt || 0).getTime();
}

function formatMoney(value: number | undefined, currency = "RUB") {
  if (value === undefined) return "-";
  return `${value.toFixed(2).replace(/\.00$/, "")} ${currency}`;
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

function statusText(value?: string) {
  if (value === "awaiting_packaging") return "等待备货";
  if (value === "awaiting_deliver") return "等待发运";
  if (value === "delivering") return "运输中";
  if (value === "delivered") return "已签收";
  if (value === "cancelled") return "已取消";
  if (value === "arbitration") return "具争议";
  return value || "-";
}

function statusClass(value?: string) {
  if (!value) return "unknown";
  return value.replace(/[^a-z0-9_-]/gi, "-");
}

function readableError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
}

function isUnsupportedLocalAssistantCommand(error: unknown, command: string) {
  const message = readableError(error).toLowerCase();
  return message.includes(command.toLowerCase())
    && (message.includes("不支持命令") || message.includes("unsupported command"));
}

async function syncCloudOrderPostings(baseUrl: string, shops: Shop[], rows: OrderPostingRow[]) {
  if (!getCloudToken() || rows.length === 0) {
    return 0;
  }
  const client = createCloudClient(baseUrl);
  await Promise.all(shops.map((shop) => client.syncShop(shop)));
  const result = await client.syncOrders(rows);
  return result.synced;
}

async function syncOrderSalesSignals(baseUrl: string, shops: Shop[], rows: OrderPostingRow[]) {
  if (!getCloudToken() || rows.length === 0) {
    return 0;
  }
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));
  const signalMap = new Map<string, {
    externalShopId: string;
    sku: string;
    orderCount: number;
    quantity: number;
    lastOrderedAt?: string;
    source: string;
  }>();

  for (const row of rows) {
    if (!row.shopId || !shopById.has(row.shopId)) {
      continue;
    }
    const products = row.products?.length
      ? row.products
      : row.offerIds.map((offerId) => ({ offerId, quantity: 1 }));
    for (const product of products) {
      const sku = product.offerId.trim();
      if (!sku) continue;
      const key = `${row.shopId}::${sku}`;
      const existing = signalMap.get(key);
      const lastOrderedAt = row.inProcessAt || row.shipmentDate;
      if (existing) {
        existing.orderCount += 1;
        existing.quantity += product.quantity || 1;
        existing.lastOrderedAt = maxIsoDate(existing.lastOrderedAt, lastOrderedAt);
      } else {
        signalMap.set(key, {
          externalShopId: row.shopId,
          sku,
          orderCount: 1,
          quantity: product.quantity || 1,
          lastOrderedAt,
          source: "order-query",
        });
      }
    }
  }

  const signals = Array.from(signalMap.values());
  if (signals.length === 0) {
    return 0;
  }

  const client = createCloudClient(baseUrl);
  for (const shop of shops) {
    await client.syncShop(shop);
  }
  const result = await client.syncSalesSignals(signals);
  return result.synced;
}

function maxIsoDate(left?: string, right?: string) {
  if (!left) return right;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}
