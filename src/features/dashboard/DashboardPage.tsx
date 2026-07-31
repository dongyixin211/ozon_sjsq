import { Activity, Boxes, PackageCheck, RefreshCw, ShoppingCart, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppSettings, JobSummary, OrderPostingRow, OzonUploadQuota, ProviderSecretStatus, Shop, ShopDailyListingStat } from "@shared/types";
import { api } from "../../lib/api";
import { createCloudClient, type CloudListingPreferences } from "../../lib/cloudApi";
import { formatDate } from "../../lib/format";

interface Props {
  shops: Shop[];
  jobs: JobSummary[];
  settings: AppSettings;
  providerSecrets: ProviderSecretStatus;
  onNavigate: (page: "ozon" | "orders" | "jobs") => void;
  onOpenJobLogs: (jobId: string) => void;
}

const ORDER_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_DAILY_LISTING_LIMIT = 300;
const DASHBOARD_STORE_PAGE_SIZE = 8;
const DASHBOARD_STORE_ROTATE_MS = 10 * 1000;
const DASHBOARD_SYNC_CONCURRENCY = 2;
const DASHBOARD_QUOTA_FILTER_KEY = "ozon-sjsq:dashboard-quota-filter:v1";
type QuotaFilter = "all" | "attention" | "processing" | "full" | "available";

export function DashboardPage({ shops, jobs, settings }: Props) {
  const [orderRows, setOrderRows] = useState<OrderPostingRow[]>([]);
  const [orderError, setOrderError] = useState("");
  const [listingStats, setListingStats] = useState<ShopDailyListingStat[]>([]);
  const [dailyListingLimits, setDailyListingLimits] = useState<Record<string, number>>({});
  const [uploadQuotas, setUploadQuotas] = useState<Record<string, OzonUploadQuota>>({});
  const [listingStatsError, setListingStatsError] = useState("");
  const [listingQuotaConfigError, setListingQuotaConfigError] = useState("");
  const [uploadQuotaError, setUploadQuotaError] = useState("");
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState("");
  const [nextRefreshAt, setNextRefreshAt] = useState("");
  const [displayOrderCount, setDisplayOrderCount] = useState(0);
  const [displayAwaitingPackagingCount, setDisplayAwaitingPackagingCount] = useState(0);
  const [displaySales, setDisplaySales] = useState(0);
  const [displayListedCount, setDisplayListedCount] = useState(0);
  const [quotaFilter, setQuotaFilter] = useState<QuotaFilter>(() => readQuotaFilter());
  const [storePageIndex, setStorePageIndex] = useState(0);
  const activeShops = shops.filter((shop) => shop.enabled);
  const runningJobs = jobs.filter((job) => job.status === "running" || job.status === "queued");
  const today = dateInputValue(0);
  const cloudClient = useMemo(() => createCloudClient(settings.cloudApiBaseUrl), [settings.cloudApiBaseUrl]);

  const loadOrderSummary = async () => {
    if (activeShops.length === 0) {
      setOrderRows([]);
      setOrderError("");
      setLastUpdatedAt(new Date().toISOString());
      setNextRefreshAt(new Date(Date.now() + ORDER_REFRESH_INTERVAL_MS).toISOString());
      return;
    }
    setLoadingOrders(true);
    try {
      const results = await Promise.allSettled(activeShops.map((shop) => api.listOrderPostings({
        shopId: shop.id,
        dateFrom: today,
        dateTo: today,
        limit: 1000,
      })));
      const rows: OrderPostingRow[] = [];
      const errors: string[] = [];
      results.forEach((result, index) => {
        const shop = activeShops[index];
        if (result.status === "fulfilled") {
          rows.push(...result.value.map((row) => ({
            ...row,
            shopId: row.shopId ?? shop.id,
            shopName: row.shopName ?? shop.name,
          })));
        } else {
          errors.push(`${shop.name}: ${String(result.reason)}`);
        }
      });
      setOrderRows(rows);
      if (rows.length > 0) {
        syncShopsWithLimit(activeShops, cloudClient, DASHBOARD_SYNC_CONCURRENCY)
          .then(() => cloudClient.syncOrders(rows))
          .catch((error) => {
            setOrderError((current) => [current, `订单同步到管理端失败：${errorMessage(error)}`].filter(Boolean).join("\n"));
          });
      }
      setOrderError(errors.join("\n"));
      setLastUpdatedAt(new Date().toISOString());
      setNextRefreshAt(new Date(Date.now() + ORDER_REFRESH_INTERVAL_MS).toISOString());
    } finally {
      setLoadingOrders(false);
    }
  };

  const loadListingStats = async () => {
    if (activeShops.length === 0) {
      setListingStats([]);
      setListingStatsError("");
      setDailyListingLimits({});
      setListingQuotaConfigError("");
      setUploadQuotas({});
      setUploadQuotaError("");
      return;
    }
    const [statsResult, preferencesResult, quotaResults] = await Promise.allSettled([
      cloudClient.listDailyListingStats({ dateFrom: today, dateTo: today }),
      cloudClient.getListingPreferences(),
      Promise.allSettled(activeShops.map((shop) => api.getShopUploadQuota(shop.id))),
    ]);

    if (statsResult.status === "fulfilled") {
      setListingStats(statsResult.value.stats);
      setListingStatsError("");
    } else {
      setListingStats([]);
      setListingStatsError(errorMessage(statsResult.reason));
    }

    if (preferencesResult.status === "fulfilled") {
      setDailyListingLimits(readDailyListingLimits(preferencesResult.value.preferences));
      setListingQuotaConfigError("");
    } else {
      setDailyListingLimits({});
      setListingQuotaConfigError(`上架额度配置查询失败，暂按 ${DEFAULT_DAILY_LISTING_LIMIT} 件限额展示：${errorMessage(preferencesResult.reason)}`);
    }

    if (quotaResults.status === "fulfilled") {
      const nextQuotas: Record<string, OzonUploadQuota> = {};
      const quotaErrors: string[] = [];
      quotaResults.value.forEach((result, index) => {
        const shop = activeShops[index];
        if (result.status === "fulfilled") {
          nextQuotas[shop.id] = result.value;
        } else {
          quotaErrors.push(`${shop.name}: ${errorMessage(result.reason)}`);
        }
      });
      setUploadQuotas(nextQuotas);
      setUploadQuotaError(quotaErrors.join("\n"));
    } else {
      setUploadQuotas({});
      setUploadQuotaError(`Ozon 实时额度查询失败：${errorMessage(quotaResults.reason)}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      loadOrderSummary().catch((error) => {
        if (!cancelled) setOrderError(String(error));
      });
      loadListingStats().catch((error) => {
        if (!cancelled) setListingStatsError(String(error));
      });
    };
    run();
    const timer = window.setInterval(run, ORDER_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [shops.map((shop) => `${shop.id}:${shop.updatedAt}:${shop.enabled}`).join("|"), settings.cloudApiBaseUrl, today]);

  const listingStatsByExternalShopId = new Map(listingStats.map((stat) => [stat.externalShopId, stat]));
  const listingStatsByShopName = new Map(listingStats.map((stat) => [stat.shopName, stat]));

  const orderSummaryRows = activeShops.map((shop) => {
    const rows = orderRows.filter((row) => row.shopId === shop.id);
    const stat = resolveListingStatForShop(shop, listingStatsByExternalShopId, listingStatsByShopName);
    const listingLimitKey = stat?.externalShopId ?? shop.id;
    const uploadQuota = uploadQuotas[shop.id];
    const dailyLimit = uploadQuota?.dailyCreateLimit
      ?? dailyListingLimits[listingLimitKey]
      ?? dailyListingLimits[shop.id]
      ?? DEFAULT_DAILY_LISTING_LIMIT;
    const listedCount = safeCount(stat?.listedCount);
    const reservedCount = Math.max(listedCount, safeCount(stat?.reservedCount));
    const pendingCount = safeCount(stat?.pendingCount);
    const createUsed = uploadQuota ? Math.max(uploadQuota.dailyCreateUsage, reservedCount) : reservedCount;
    const createRemaining = uploadQuota?.dailyCreateRemaining ?? Math.max(0, dailyLimit - createUsed);
    const totalRemaining = uploadQuota?.totalRemaining ?? Math.max(0, dailyLimit - reservedCount);
    const remaining = Math.min(createRemaining, totalRemaining);
    const blocked = totalRemaining <= 0 ? "总额度已满" : createRemaining <= 0 ? "新建额度已满" : pendingCount > 0 ? "处理中" : reservedCount > dailyLimit ? "已超额" : "可用";
    return {
      shop,
      count: rows.length,
      sales: rows.reduce((sum, row) => sum + (row.salesAmount ?? 0), 0),
      awaitingPackagingCount: rows.filter((row) => row.status === "awaiting_packaging").length,
      currency: rows.find((row) => row.currencyCode)?.currencyCode ?? "RUB",
      listedCount,
      reservedCount,
      pendingCount,
      dailyLimit,
      createUsed,
      createRemaining,
      totalRemaining,
      remaining,
      blocked,
      quotaUsedPercent: dailyLimit > 0 ? Math.min(100, Math.round((createUsed / dailyLimit) * 100)) : 0,
    };
  });
  const totalOrderCount = orderSummaryRows.reduce((sum, row) => sum + row.count, 0);
  const totalAwaitingPackagingCount = orderSummaryRows.reduce((sum, row) => sum + row.awaitingPackagingCount, 0);
  const totalSales = orderSummaryRows.reduce((sum, row) => sum + row.sales, 0);
  const totalListedCount = orderSummaryRows.reduce((sum, row) => sum + row.listedCount, 0);
  const currency = orderSummaryRows.find((row) => row.currency)?.currency ?? "RUB";
  const topShop = [...orderSummaryRows].sort((left, right) => right.sales - left.sales)[0];
  const quotaRows = orderSummaryRows.filter((row) => quotaFilterMatches(row, quotaFilter));
  const storePageCount = Math.max(1, Math.ceil(quotaRows.length / DASHBOARD_STORE_PAGE_SIZE));
  const safeStorePageIndex = Math.min(storePageIndex, storePageCount - 1);
  const storePageStart = safeStorePageIndex * DASHBOARD_STORE_PAGE_SIZE;
  const visibleQuotaRows = quotaRows.slice(storePageStart, storePageStart + DASHBOARD_STORE_PAGE_SIZE);
  const storePageLabel = quotaRows.length === 0
    ? "暂无店铺"
    : `第 ${safeStorePageIndex + 1} / ${storePageCount} 屏 · ${storePageStart + 1}-${Math.min(storePageStart + DASHBOARD_STORE_PAGE_SIZE, quotaRows.length)} / ${quotaRows.length} 家`;

  useEffect(() => {
    const cleanupCount = animateNumber(displayOrderCount, totalOrderCount, 650, setDisplayOrderCount);
    const cleanupAwaitingPackaging = animateNumber(displayAwaitingPackagingCount, totalAwaitingPackagingCount, 650, setDisplayAwaitingPackagingCount);
    const cleanupSales = animateNumber(displaySales, totalSales, 800, setDisplaySales);
    const cleanupListed = animateNumber(displayListedCount, totalListedCount, 650, setDisplayListedCount);
    return () => {
      cleanupCount();
      cleanupAwaitingPackaging();
      cleanupSales();
      cleanupListed();
    };
  }, [totalOrderCount, totalAwaitingPackagingCount, totalSales, totalListedCount]);

  useEffect(() => {
    writeQuotaFilter(quotaFilter);
  }, [quotaFilter]);

  useEffect(() => {
    setStorePageIndex(0);
  }, [quotaFilter]);

  useEffect(() => {
    setStorePageIndex((current) => Math.min(current, storePageCount - 1));
  }, [storePageCount]);

  useEffect(() => {
    if (storePageCount <= 1) return undefined;
    const timer = window.setInterval(() => {
      setStorePageIndex((current) => (current + 1) % storePageCount);
    }, DASHBOARD_STORE_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [storePageCount]);

  return (
    <div className="content-grid dashboard-page dashboard-cockpit" role="region" aria-label="首页数据大屏">
      <section className="panel order-screen dashboard-hero">
        <div className="order-screen-bg" aria-hidden="true" />
        <div className="order-screen-head dashboard-hero-head">
          <div>
            <span className="eyebrow">今日数据大屏 · {today} · 更新 {lastUpdatedAt ? formatDate(lastUpdatedAt) : "等待查询"} · 店铺 {activeShops.length} · 任务 {runningJobs.length}</span>
            <h2>店铺运营总览</h2>
          </div>
          <div className="toolbar">
            <span className={loadingOrders ? "status-pill order-live is-loading" : "status-pill order-live"}>
              <Activity size={14} />
              {loadingOrders ? "正在更新" : "动态展示"}
            </span>
            <button className="secondary-button order-refresh-button" onClick={() => {
              loadOrderSummary().catch((error) => setOrderError(String(error)));
              loadListingStats().catch((error) => setListingStatsError(String(error)));
            }} disabled={loadingOrders}>
              <RefreshCw size={15} className={loadingOrders ? "spin-icon" : undefined} />
              立即刷新
            </button>
          </div>
        </div>

        <div className="order-metrics metric-grid dashboard-kpis" role="list" aria-label="今日运营指标">
          <div className="order-metric-card metric-card primary" role="listitem">
            <span><ShoppingCart size={18} /> 今日单量</span>
            <strong>{Math.round(displayOrderCount).toLocaleString("zh-CN")}</strong>
            <em>所有启用店铺合计</em>
          </div>
          <div className="order-metric-card metric-card" role="listitem">
            <span><PackageCheck size={18} /> 待备货</span>
            <strong>{Math.round(displayAwaitingPackagingCount).toLocaleString("zh-CN")}</strong>
            <em>需要处理的订单</em>
          </div>
          <div className="order-metric-card metric-card" role="listitem">
            <span><WalletCards size={18} /> 今日销售额</span>
            <strong>{formatMoney(displaySales, currency)}</strong>
            <em>{topShop ? `最高：${topShop.shop.name}` : "等待订单数据"}</em>
          </div>
          <div className="order-metric-card metric-card" role="listitem">
            <span><Boxes size={18} /> 今日上架商品</span>
            <strong>{Math.round(displayListedCount).toLocaleString("zh-CN")}</strong>
            <em>成功货号去重统计</em>
          </div>
        </div>
      </section>

      <div className="dashboard-main-grid">
        <section className="panel dashboard-store-panel">
          <div className="panel-header dashboard-store-head">
            <div>
              <h2>店铺健康矩阵</h2>
              <span className="dashboard-store-page-label">{storePageLabel}</span>
            </div>
            <div className="toolbar quota-toolbar">
              <div className="dashboard-store-pager" aria-label="店铺分页控制">
                <button
                  className="secondary-button"
                  onClick={() => setStorePageIndex((current) => (current - 1 + storePageCount) % storePageCount)}
                  disabled={storePageCount <= 1}
                  aria-label="上一屏店铺"
                >
                  上一屏
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setStorePageIndex((current) => (current + 1) % storePageCount)}
                  disabled={storePageCount <= 1}
                  aria-label="下一屏店铺"
                >
                  下一屏
                </button>
              </div>
              <div className="segmented-control quota-filter-tabs">
                {quotaFilterOptions.map((option) => (
                  <button
                    key={option.key}
                    className={quotaFilter === option.key ? "active" : undefined}
                    onClick={() => setQuotaFilter(option.key)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button className="secondary-button" onClick={() => {
                loadListingStats().catch((error) => setListingStatsError(String(error)));
              }}>
                <RefreshCw size={15} />
                刷新额度
              </button>
            </div>
          </div>
          <div className="dashboard-store-matrix" role="list" aria-label="店铺健康矩阵">
            {visibleQuotaRows.map((row) => (
              <article className="dashboard-store-card" key={row.shop.id} role="listitem">
                <header>
                  <div className="dashboard-store-title">
                    <strong>{row.shop.name}</strong>
                    <span>{row.shop.apiKeyStored ? "API 可查" : "缺少 API Key"} · Cookie {row.shop.ozonSellerCookieStored ? "已保存" : "未保存"}</span>
                  </div>
                  <span className={quotaStatusClass(row)}>{quotaStatusText(row)}</span>
                </header>
                <div className="dashboard-store-stats">
                  <span><em>单量</em><strong>{row.count}</strong></span>
                  <span><em>待备货</em><strong>{row.awaitingPackagingCount}</strong></span>
                  <span><em>销售额</em><strong>{formatMoney(row.sales, row.currency)}</strong></span>
                  <span><em>上架</em><strong>{row.listedCount}</strong></span>
                </div>
                <div className="dashboard-store-quota">
                  <div>
                    <span>新建剩余</span>
                    <strong>{row.createRemaining}</strong>
                  </div>
                  <div>
                    <span>总剩余</span>
                    <strong>{row.totalRemaining}</strong>
                  </div>
                  <div className="order-shop-bar quota-bar">
                    <span
                      className={row.remaining <= 0 ? "is-full" : undefined}
                      style={{ width: `${row.quotaUsedPercent}%` }}
                    />
                  </div>
                </div>
              </article>
            ))}
            {orderSummaryRows.length === 0 ? <div className="dashboard-store-empty muted">暂无启用店铺。</div> : null}
            {orderSummaryRows.length > 0 && quotaRows.length === 0 ? <div className="dashboard-store-empty muted">当前筛选下没有店铺。</div> : null}
          </div>
        </section>

      </div>

    </div>
  );
}

async function syncShopsWithLimit(shops: Shop[], cloudClient: ReturnType<typeof createCloudClient>, concurrency: number) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), shops.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < shops.length) {
      const shop = shops[nextIndex];
      nextIndex += 1;
      await cloudClient.syncShop(shop);
    }
  }));
}

function dateInputValue(daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMoney(value: number, currency = "RUB") {
  return `${value.toFixed(2).replace(/\.00$/, "")} ${currency}`;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const quotaFilterOptions: Array<{ key: QuotaFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "attention", label: "需关注" },
  { key: "processing", label: "处理中" },
  { key: "full", label: "已满" },
  { key: "available", label: "可用" },
];

function readQuotaFilter(): QuotaFilter {
  if (typeof window === "undefined") return "all";
  const value = window.localStorage.getItem(DASHBOARD_QUOTA_FILTER_KEY);
  return isQuotaFilter(value) ? value : "all";
}

function writeQuotaFilter(value: QuotaFilter) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DASHBOARD_QUOTA_FILTER_KEY, value);
  } catch {
    // 首页筛选只是体验项，写入失败不能影响主流程。
  }
}

function isQuotaFilter(value: unknown): value is QuotaFilter {
  return value === "all"
    || value === "attention"
    || value === "processing"
    || value === "full"
    || value === "available";
}

function quotaFilterMatches(
  row: { blocked: string; pendingCount: number; remaining: number },
  filter: QuotaFilter,
) {
  if (filter === "all") return true;
  if (filter === "attention") return row.blocked !== "可用";
  if (filter === "processing") return row.pendingCount > 0;
  if (filter === "full") return row.remaining <= 0 || row.blocked === "已超额";
  return row.blocked === "可用";
}

function resolveListingStatForShop(
  shop: Shop,
  statsByExternalShopId: Map<string, ShopDailyListingStat>,
  statsByShopName: Map<string, ShopDailyListingStat>,
) {
  return statsByExternalShopId.get(shop.id) ?? statsByShopName.get(shop.name);
}

function readDailyListingLimits(preferences: CloudListingPreferences) {
  const limits: Record<string, number> = {};
  for (const config of preferences.shopListingConfigs ?? []) {
    if (!config.externalShopId) continue;
    limits[config.externalShopId] = normalizePositiveInt(config.dailyListingLimit, DEFAULT_DAILY_LISTING_LIMIT);
  }
  return limits;
}

function quotaStatusText(row: { blocked: string }) {
  return row.blocked;
}

function quotaStatusClass(row: { blocked: string; pendingCount: number }) {
  if (row.blocked === "总额度已满" || row.blocked === "新建额度已满" || row.blocked === "已超额") return "badge warn";
  if (row.pendingCount > 0) return "badge neutral";
  return "status-pill";
}

function safeCount(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizePositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function animateNumber(from: number, to: number, durationMs: number, setValue: (value: number) => void) {
  if (from === to) {
    setValue(to);
    return () => undefined;
  }
  const startedAt = performance.now();
  let frameId = 0;
  const tick = (time: number) => {
    const progress = Math.min(1, (time - startedAt) / durationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    setValue(from + (to - from) * eased);
    if (progress < 1) {
      frameId = window.requestAnimationFrame(tick);
    } else {
      setValue(to);
    }
  };
  frameId = window.requestAnimationFrame(tick);
  return () => window.cancelAnimationFrame(frameId);
}
