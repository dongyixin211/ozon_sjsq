import { useEffect, useMemo, useState } from "react";
import type { AppSettings, OrderPostingRow, Shop } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";
import { parseOrderNumbers } from "../ozon/orderUtils";

interface Props {
  shops: Shop[];
  settings: AppSettings;
  onChanged: () => void;
  onNavigate: (page: "jobs" | "settings") => void;
}

function dateInputValue(daysAgo: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

export function OrdersPage({ shops, settings, onChanged, onNavigate }: Props) {
  const activeShops = shops.filter((shop) => shop.enabled);
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>(activeShops.map((shop) => shop.id));
  const [dateFrom, setDateFrom] = useState(dateInputValue(0));
  const [dateTo, setDateTo] = useState(dateInputValue(0));
  const [status, setStatus] = useState("");
  const [limit, setLimit] = useState(100);
  const [rows, setRows] = useState<OrderPostingRow[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [outputRoot, setOutputRoot] = useState(settings.defaultOutputRoot);
  const [manualShopId, setManualShopId] = useState(activeShops[0]?.id ?? "");
  const [manualOrdersText, setManualOrdersText] = useState("");
  const [cookieShopId, setCookieShopId] = useState(activeShops[0]?.id ?? "");
  const [sellerCookie, setSellerCookie] = useState("");
  const [downloadMaterials, setDownloadMaterials] = useState(false);
  const [baiduCookie, setBaiduCookie] = useState(settings.baiduCookie);
  const [baiduSearchDir, setBaiduSearchDir] = useState("/");
  const [baiduRecursive, setBaiduRecursive] = useState(true);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selectedShopIds.length === 0 && activeShops.length > 0) {
      setSelectedShopIds(activeShops.map((shop) => shop.id));
    }
    if (!manualShopId && activeShops[0]) setManualShopId(activeShops[0].id);
    if (!cookieShopId && activeShops[0]) setCookieShopId(activeShops[0].id);
  }, [activeShops, selectedShopIds.length, manualShopId, cookieShopId]);

  const selectedRows = rows.filter((row) => selectedKeys.includes(rowKey(row)));
  const totals = useMemo(() => summarizeOrders(rows), [rows]);
  const selectedTotals = useMemo(() => summarizeOrders(selectedRows), [selectedRows]);

  const toggleShop = (shopId: string, checked: boolean) => {
    setSelectedShopIds((current) => checked ? Array.from(new Set([...current, shopId])) : current.filter((id) => id !== shopId));
  };

  const loadOrders = async () => {
    if (selectedShopIds.length === 0) throw new Error("请至少选择一个店铺");
    if (!dateFrom || !dateTo) throw new Error("请选择订单日期");
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
        status: status || undefined,
        limit,
      })));
      const nextRows: OrderPostingRow[] = [];
      const errors: string[] = [];
      settled.forEach((item, index) => {
        const shop = targetShops[index];
        if (item.status === "fulfilled") {
          nextRows.push(...item.value.map((row) => ({
            ...row,
            shopId: row.shopId ?? shop.id,
            shopName: row.shopName ?? shop.name,
          })));
        } else {
          errors.push(`${shop.name}: ${String(item.reason)}`);
        }
      });
      setRows(nextRows);
      setSelectedKeys([]);
      setMessage(`已获取 ${nextRows.length} 个订单/货件，销售额 ${formatMoney(totalsByRows(nextRows))}。`);
      setResult(errors.length ? errors.join("\n") : "");
    } finally {
      setLoading(false);
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

  const downloadRows = async (rowsToDownload: OrderPostingRow[]) => {
    if (rowsToDownload.length === 0) throw new Error("请先勾选要下载的订单");
    if (!outputRoot.trim()) throw new Error("请选择输出目录");
    const byShop = new Map<string, OrderPostingRow[]>();
    for (const row of rowsToDownload) {
      if (!row.shopId) continue;
      byShop.set(row.shopId, [...(byShop.get(row.shopId) ?? []), row]);
    }
    const jobs = [];
    for (const [shopId, shopRows] of byShop) {
      const shop = shops.find((item) => item.id === shopId);
      if (!shop) continue;
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
      });
      jobs.push(job);
    }
    setMessage(`已按店铺提交 ${jobs.length} 个订单下载任务。`);
    setResult(JSON.stringify(jobs, null, 2));
    onChanged();
    onNavigate("jobs");
  };

  const downloadManual = async () => {
    const orderNumbers = parseOrderNumbers(manualOrdersText);
    if (!manualShopId) throw new Error("请选择店铺");
    if (orderNumbers.length === 0) throw new Error("请输入订单/货件编号");
    const shop = shops.find((item) => item.id === manualShopId);
    const rowsToDownload = orderNumbers.map((postingNumber) => ({
      shopId: manualShopId,
      shopName: shop?.name,
      postingNumber,
      productsCount: 0,
      offerIds: [],
    }));
    await downloadRows(rowsToDownload);
  };

  const toggleRow = (row: OrderPostingRow, checked: boolean) => {
    const key = rowKey(row);
    setSelectedKeys((current) => checked ? Array.from(new Set([...current, key])) : current.filter((item) => item !== key));
  };

  const toggleAllRows = (checked: boolean) => {
    setSelectedKeys(checked ? rows.map(rowKey) : []);
  };

  return (
    <div className="content-grid">
      {message ? <section className="panel"><span className="badge">{message}</span></section> : null}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>所有店铺订单查询</h2>
            <p className="muted">订单列表使用各店铺 Ozon API Key 查询；下载 PDF 时使用订单所属店铺自己的后台 Cookie。</p>
          </div>
          <div className="toolbar">
            <button className="primary-button" onClick={() => loadOrders().catch((error) => setResult(String(error)))} disabled={loading}>
              {loading ? "查询中" : "查询订单"}
            </button>
            <button className="secondary-button" onClick={() => downloadRows(selectedRows).catch((error) => setResult(String(error)))} disabled={selectedRows.length === 0}>
              下载勾选 ({selectedRows.length})
            </button>
          </div>
        </div>
        <div className="form-grid compact-form-grid">
          <div className="field">
            <label>开始日期</label>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </div>
          <div className="field">
            <label>结束日期</label>
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </div>
          <div className="field">
            <label>订单状态</label>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部状态</option>
              <option value="awaiting_packaging">待打包</option>
              <option value="awaiting_deliver">待发货</option>
              <option value="delivering">配送中</option>
              <option value="delivered">已签收</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
          <div className="field">
            <label>每店最多返回</label>
            <input type="number" min={1} max={1000} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
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
            <span>查询订单</span>
            <strong>{rows.length}</strong>
            <em>{dateFrom} 至 {dateTo}</em>
          </div>
          <div className="status-block">
            <span>查询销售额</span>
            <strong>{formatMoney(totals)}</strong>
            <em>按订单商品价格求和</em>
          </div>
          <div className="status-block">
            <span>已勾选</span>
            <strong>{selectedRows.length}</strong>
            <em>{formatMoney(selectedTotals)}</em>
          </div>
          <div className="status-block">
            <span>Cookie</span>
            <strong>{activeShops.filter((shop) => shop.ozonSellerCookieStored).length}/{activeShops.length}</strong>
            <em>每店单独保存</em>
          </div>
          <div className="status-block">
            <span>下载目录</span>
            <strong>{outputRoot ? "已选择" : "未选择"}</strong>
            <em>{outputRoot || "-"}</em>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>订单列表</h2>
          <button className="secondary-button" onClick={() => toggleAllRows(selectedKeys.length !== rows.length)}>
            {selectedKeys.length === rows.length && rows.length > 0 ? "取消全选" : "全选"}
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th></th><th>店铺</th><th>货件编号</th><th>订单号</th><th>状态</th><th>商品</th><th>销售额</th><th>处理时间</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)}>
                  <td><input type="checkbox" checked={selectedKeys.includes(rowKey(row))} onChange={(event) => toggleRow(row, event.target.checked)} /></td>
                  <td>{row.shopName || row.shopId || "-"}</td>
                  <td>{row.postingNumber}</td>
                  <td>{row.orderNumber || row.orderId || "-"}</td>
                  <td>{row.status || "-"}</td>
                  <td><div>{row.productsCount} 件</div><div className="muted">{row.offerIds.slice(0, 4).join("，") || "-"}</div></td>
                  <td>{formatMoney(row.salesAmount, row.currencyCode)}</td>
                  <td>{formatDateTime(row.inProcessAt)}</td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td colSpan={8} className="muted">选择店铺和日期后查询订单。</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>下载设置</h2>
            <p className="muted">Ozon 后台 Cookie 按店铺分别保存；不同店铺不会共用。</p>
          </div>
          <button className="secondary-button" onClick={() => saveSellerCookie().catch((error) => setResult(String(error)))}>保存当前店铺 Cookie</button>
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
          <button className="primary-button" onClick={() => downloadManual().catch((error) => setResult(String(error)))}>下载输入编号</button>
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

      {result ? <section className="panel"><pre className="long-output">{result}</pre></section> : null}
    </div>
  );
}

function rowKey(row: OrderPostingRow) {
  return `${row.shopId || ""}::${row.postingNumber}`;
}

function summarizeOrders(rows: OrderPostingRow[]) {
  return rows.reduce((sum, row) => sum + (row.salesAmount ?? 0), 0);
}

function totalsByRows(rows: OrderPostingRow[]) {
  return summarizeOrders(rows);
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
