import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, OrderPostingRow, Shop, StoredOrderQuery } from "@shared/types";
import { api } from "../../lib/api";
import { OrdersPage } from "./OrdersPage";

vi.mock("../../lib/api", () => ({
  api: {
    listSavedOrderPostings: vi.fn().mockResolvedValue([]),
    listOrderPostings: vi.fn(),
    shipOrderPosting: vi.fn(),
    saveShopSellerCookie: vi.fn(),
    reserveOrderShippingLabels: vi.fn().mockResolvedValue(undefined),
    downloadOrderShippingLabels: vi.fn().mockResolvedValue(undefined),
    startOrderDocuments: vi.fn().mockResolvedValue({ id: "order-job", kind: "order_documents", title: "订单文件下载", status: "queued", progress: 0, createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z" }),
  },
}));

vi.mock("../../lib/cloudApi", () => ({
  createCloudClient: vi.fn(() => ({
    syncSalesSignals: vi.fn(),
  })),
  getCloudToken: vi.fn(() => ""),
}));

const draftKey = "ozon-sjsq:order-documents-draft:v1";
const orderJob = { id: "order-job", kind: "order_documents", title: "订单文件下载", status: "queued", progress: 0, createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z" } as const;

const settings: AppSettings = {
  cloudApiBaseUrl: "https://api.example.test",
  defaultSourceRoot: "",
  defaultOutputRoot: "E:\\default-output",
  baiduCookie: "",
  watermarkPath: "",
  contentRoot: "",
  uploadExcelPath: "",
  uploadMaxItems: 100,
  listedUpdateMaxWorkers: 2,
  imageProvider: "pixel",
  textProvider: "xiaoqian",
  imageBaseUrl: "",
  textBaseUrl: "",
  imageModel: "",
  textModel: "",
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

function shop(id: string, name: string, enabled = true): Shop {
  return {
    id,
    name,
    clientId: `client-${id}`,
    apiKeyStored: true,
    ossAccessKeyStored: true,
    ozonSellerCookieStored: false,
    enabled,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function order(postingNumber: string, status: string): OrderPostingRow {
  return {
    shopId: "shop-a",
    shopName: "主店",
    postingNumber,
    status,
    productsCount: 1,
    offerIds: [`SKU-${postingNumber}`],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("OrdersPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.listSavedOrderPostings).mockReset().mockResolvedValue([]);
    vi.mocked(api.listOrderPostings).mockReset();
    vi.mocked(api.reserveOrderShippingLabels).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.downloadOrderShippingLabels).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.startOrderDocuments).mockReset().mockResolvedValue(orderJob);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("restores saved filters and drops invalid shop selections", async () => {
    window.localStorage.setItem(draftKey, JSON.stringify({
      selectedShopIds: ["shop-a", "missing-shop"],
      manualShopId: "missing-shop",
      cookieShopId: "shop-a",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-09",
      syncStatus: "awaiting_packaging",
      statusFilter: "delivering",
      keyword: "SKU-001",
      limit: 25,
      orderOutputRoot: "E:\\last-output",
      baiduSearchDir: "/orders",
      baiduRecursive: false,
      downloadMaterials: false,
    }));

    render(
      <OrdersPage
        shops={[shop("shop-a", "跟卖1"), shop("shop-b", "停用店铺", false)]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listSavedOrderPostings).toHaveBeenCalledWith({
      shopIds: ["shop-a"],
      status: "delivering",
      keyword: "SKU-001",
      limit: 25,
    }));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(draftKey) || "{}");
      expect(saved.selectedShopIds).toEqual(["shop-a"]);
      expect(saved.manualShopId).toBe("shop-a");
      expect(saved.cookieShopId).toBe("shop-a");
      expect(saved.orderOutputRoot).toBe("E:\\last-output");
      expect(saved.baiduSearchDir).toBe("/orders");
      expect(saved.downloadMaterials).toBe(false);
    });
  });

  it("paginates loaded orders with ten rows by default and selectable page sizes", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => order(`ORDER-${String(index + 1).padStart(2, "0")}`, "awaiting_packaging"));
    vi.mocked(api.listSavedOrderPostings).mockResolvedValue(rows);

    render(
      <OrdersPage
        shops={[shop("shop-a", "主店")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(await screen.findByText("ORDER-01")).toBeTruthy();
    expect(screen.getByText("第 1 / 2 页")).toBeTruthy();
    expect(screen.getByText("显示 1-10，共 12 条")).toBeTruthy();
    expect(screen.getByText("ORDER-10")).toBeTruthy();
    expect(screen.queryByText("ORDER-11")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "下一页订单" }));

    expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
    expect(screen.getByText("显示 11-12，共 12 条")).toBeTruthy();
    expect(screen.getByText("ORDER-11")).toBeTruthy();
    expect(screen.queryByText("ORDER-01")).toBeNull();

    fireEvent.change(screen.getByLabelText("每页订单数"), { target: { value: "20" } });

    expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
    expect(screen.getByText("显示 1-12，共 12 条")).toBeTruthy();
    expect(screen.getByText("ORDER-01")).toBeTruthy();
    expect(screen.getByText("ORDER-12")).toBeTruthy();
  });
  it("loads all statuses after switching from awaiting packaging to all", async () => {
    const waitingOrder = order("waiting-order", "awaiting_packaging");
    const deliveredOrder = order("delivered-order", "delivered");
    vi.mocked(api.listSavedOrderPostings).mockImplementation(async (query: StoredOrderQuery = {}) => (
      query.status === "awaiting_packaging" ? [waitingOrder] : [waitingOrder, deliveredOrder]
    ));

    render(<OrdersPage shops={[shop("shop-a", "主店")]} settings={settings} onChanged={vi.fn()} onNavigate={vi.fn()} />);

    expect(await screen.findByText("delivered-order")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /等待备货/ }));
    await waitFor(() => expect(screen.queryByText("delivered-order")).toBeNull());

    const callsBeforeAll = vi.mocked(api.listSavedOrderPostings).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /全部/ }));
    await waitFor(() => expect(vi.mocked(api.listSavedOrderPostings).mock.calls.length).toBeGreaterThan(callsBeforeAll));

    const allStatusCalls = vi.mocked(api.listSavedOrderPostings).mock.calls.slice(callsBeforeAll);
    expect(allStatusCalls.every(([query]) => query?.status === undefined)).toBe(true);
    expect(await screen.findByText("delivered-order")).toBeTruthy();
  });

  it("ignores an older saved-order response that resolves after the latest request", async () => {
    const waitingListRequest = deferred<OrderPostingRow[]>();
    const waitingSummaryRequest = deferred<OrderPostingRow[]>();
    const waitingOrder = { ...order("waiting-order", "awaiting_packaging"), salesAmount: 111 };
    const waitingSummary = [
      waitingOrder,
      order("waiting-order-2", "awaiting_packaging"),
      order("cancelled-order", "cancelled"),
    ];
    const allOrder = { ...order("all-order", "delivered"), salesAmount: 222 };
    const latestSummary = [
      allOrder,
      order("delivering-order-1", "delivering"),
      order("delivering-order-2", "delivering"),
    ];
    let noStatusCalls = 0;
    vi.mocked(api.listSavedOrderPostings).mockImplementation((query: StoredOrderQuery = {}) => {
      if (query.status === "awaiting_packaging") {
        return waitingListRequest.promise;
      }
      noStatusCalls += 1;
      if (noStatusCalls <= 2) return Promise.resolve([]);
      if (noStatusCalls === 3) return waitingSummaryRequest.promise;
      return Promise.resolve(noStatusCalls === 4 ? [allOrder] : latestSummary);
    });

    render(<OrdersPage shops={[shop("shop-a", "主店")]} settings={settings} onChanged={vi.fn()} onNavigate={vi.fn()} />);

    await waitFor(() => expect(vi.mocked(api.listSavedOrderPostings).mock.calls.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /等待备货/ }));
    await waitFor(() => expect(noStatusCalls).toBe(3));
    fireEvent.click(screen.getByRole("button", { name: /全部/ }));

    const latestPosting = await screen.findByText("all-order");
    const latestMessage = "已加载本地历史订单 1 个，销售额 222 RUB。";
    expect(screen.getByText(latestMessage)).toBeTruthy();
    expect(screen.getByRole("button", { name: /全部/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /等待备货/ }).textContent).toContain("0");
    expect(screen.getByRole("button", { name: /运输中/ }).textContent).toContain("2");
    const latestRow = latestPosting.closest("tr");
    fireEvent.click(latestRow!.querySelector("input[type='checkbox']")!);
    expect(screen.getByRole("button", { name: /下载勾选 \(1\)/ })).toBeTruthy();

    waitingListRequest.resolve([waitingOrder]);
    waitingSummaryRequest.resolve(waitingSummary);
    await waitFor(() => expect(screen.queryByText("waiting-order")).toBeNull());
    expect(screen.getByText("all-order")).toBeTruthy();
    expect(screen.getByText(latestMessage)).toBeTruthy();
    expect(screen.queryByText("已加载本地历史订单 1 个，销售额 111 RUB。")).toBeNull();
    expect(screen.getByRole("button", { name: /全部/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /等待备货/ }).textContent).toContain("0");
    expect(screen.getByRole("button", { name: /运输中/ }).textContent).toContain("2");
    expect(screen.getByRole("button", { name: /下载勾选 \(1\)/ })).toBeTruthy();
  });

  it("uses an unfiltered summary for status counts in the current shop and keyword scope", async () => {
    window.localStorage.setItem(draftKey, JSON.stringify({
      selectedShopIds: ["shop-a"],
      statusFilter: "awaiting_packaging",
      keyword: "SKU-001",
      limit: 25,
    }));
    const waitingOrder = order("waiting-order", "awaiting_packaging");
    const deliveringOrder = order("delivering-order", "delivering");
    vi.mocked(api.listSavedOrderPostings).mockImplementation(async (query: StoredOrderQuery = {}) => (
      query.status ? [waitingOrder] : [waitingOrder, deliveringOrder]
    ));

    render(<OrdersPage shops={[shop("shop-a", "主店")]} settings={settings} onChanged={vi.fn()} onNavigate={vi.fn()} />);

    expect(await screen.findByText("waiting-order")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: /运输中/ }).textContent).toContain("1"));
    expect(api.listSavedOrderPostings).toHaveBeenCalledWith({
      shopIds: ["shop-a"],
      status: undefined,
      keyword: "SKU-001",
      limit: 25,
    });
  });

  it("clears selected rows after a successful reload", async () => {
    const firstOrder = order("first-order", "awaiting_packaging");
    const secondOrder = order("second-order", "delivered");
    vi.mocked(api.listSavedOrderPostings).mockResolvedValue([firstOrder]);

    render(<OrdersPage shops={[shop("shop-a", "主店")]} settings={settings} onChanged={vi.fn()} onNavigate={vi.fn()} />);

    const firstPosting = await screen.findByText("first-order");
    fireEvent.click(firstPosting.closest("tr")!.querySelector("input[type='checkbox']")!);
    expect(screen.getByRole("button", { name: /下载勾选 \(1\)/ })).toBeTruthy();

    vi.mocked(api.listSavedOrderPostings).mockResolvedValue([secondOrder]);
    fireEvent.click(screen.getByRole("button", { name: "查询历史" }));

    expect(await screen.findByText("second-order")).toBeTruthy();
    expect(screen.getByRole("button", { name: /下载勾选 \(0\)/ })).toBeTruthy();
  });

  it("shows the product main image and persisted download status", async () => {
    vi.mocked(api.listSavedOrderPostings).mockResolvedValueOnce([{
      shopId: "shop-a",
      shopName: "跟卖1",
      postingNumber: "69564471-1811-1",
      productsCount: 1,
      offerIds: ["SKU-001"],
      imageUrl: "https://cdn.example.test/main.jpg",
      downloadedAt: "2026-07-12T02:30:00.000Z",
      downloadOutputPath: "E:\\orders\\69564471-1811-1",
    }]);

    render(
      <OrdersPage
        shops={[shop("shop-a", "跟卖1")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(await screen.findByText("已下载")).toBeTruthy();
    const image = await screen.findByAltText("SKU-001");
    expect(image.getAttribute("src")).toBe("https://cdn.example.test/main.jpg");
  });

  it("maps one unique logistics PDF to each selected order before downloading", async () => {
    window.localStorage.setItem(draftKey, JSON.stringify({ orderOutputRoot: "E:\\orders" }));
    vi.mocked(api.listSavedOrderPostings).mockResolvedValueOnce([{
      shopId: "shop-a",
      shopName: "主店",
      postingNumber: "9977740-0001-1",
      productsCount: 1,
      offerIds: ["SKU-001"],
    }]);
    const onNavigate = vi.fn();

    render(<OrdersPage shops={[shop("shop-a", "主店")]} settings={settings} onChanged={vi.fn()} onNavigate={onNavigate} />);

    const posting = await screen.findByText("9977740-0001-1");
    const row = posting.closest("tr");
    const downloadButton = row?.querySelector("button.secondary-button");
    expect(downloadButton).toBeTruthy();
    fireEvent.click(downloadButton!);
    const dialog = await screen.findByRole("dialog", { name: "填写物流贴单地址" });
    const url = "https://youla-gl.ilinexpress.com/gl/TYP_COLLECT_BAG_PDF/2026/07/2026-07-27/9977740afb084bb9a72e80c6dbd27725.pdf";
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: "确认并下载" }));

    await waitFor(() => expect(api.reserveOrderShippingLabels).toHaveBeenCalledWith([{
      shopId: "shop-a",
      orderNumber: "9977740-0001-1",
      url,
    }]));
    expect(api.downloadOrderShippingLabels).not.toHaveBeenCalled();
    expect(api.startOrderDocuments).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-a",
      orderNumbers: ["9977740-0001-1"],
      outputRoot: "E:\\orders",
      shippingLabels: [{
        orderNumber: "9977740-0001-1",
        url,
      }],
    }));
    expect(onNavigate).toHaveBeenCalledWith("jobs");
  });

  it("continues with the legacy order command when the assistant lacks the reserve command", async () => {
    window.localStorage.setItem(draftKey, JSON.stringify({ orderOutputRoot: "E:\\orders" }));
    vi.mocked(api.listSavedOrderPostings).mockResolvedValueOnce([{
      shopId: "shop-a",
      shopName: "主店",
      postingNumber: "legacy-order",
      productsCount: 1,
      offerIds: ["SKU-LEGACY"],
    }]);
    vi.mocked(api.reserveOrderShippingLabels).mockRejectedValueOnce(
      new Error("本地助手不支持命令：reserve_order_shipping_labels"),
    );

    render(<OrdersPage shops={[shop("shop-a", "主店")]} settings={settings} onChanged={vi.fn()} onNavigate={vi.fn()} />);

    const posting = await screen.findByText("legacy-order");
    fireEvent.click(posting.closest("tr")!.querySelector("button.secondary-button")!);
    const dialog = await screen.findByRole("dialog", { name: "填写物流贴单地址" });
    const url = "https://labels.example.test/legacy.pdf";
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: "确认并下载" }));

    await waitFor(() => expect(api.startOrderDocuments).toHaveBeenCalledWith(expect.objectContaining({
      orderNumbers: ["legacy-order"],
      shippingLabels: [{ orderNumber: "legacy-order", url }],
    })));
  });

  it("stops downloading when reserving logistics URLs fails for a real conflict", async () => {
    window.localStorage.setItem(draftKey, JSON.stringify({ orderOutputRoot: "E:\\orders" }));
    vi.mocked(api.listSavedOrderPostings).mockResolvedValueOnce([{
      shopId: "shop-a",
      shopName: "主店",
      postingNumber: "conflict-order",
      productsCount: 1,
      offerIds: ["SKU-CONFLICT"],
    }]);
    vi.mocked(api.reserveOrderShippingLabels).mockRejectedValueOnce(
      new Error("物流贴单地址已绑定到其他订单"),
    );

    render(<OrdersPage shops={[shop("shop-a", "主店")]} settings={settings} onChanged={vi.fn()} onNavigate={vi.fn()} />);

    const posting = await screen.findByText("conflict-order");
    fireEvent.click(posting.closest("tr")!.querySelector("button.secondary-button")!);
    const dialog = await screen.findByRole("dialog", { name: "填写物流贴单地址" });
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: "https://labels.example.test/conflict.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并下载" }));

    expect(await screen.findByText("物流贴单地址已绑定到其他订单")).toBeTruthy();
    expect(api.startOrderDocuments).not.toHaveBeenCalled();
  });
  it("maps multiple logistics PDFs to their orders within each shop", async () => {
    window.localStorage.setItem(draftKey, JSON.stringify({ orderOutputRoot: "E:\\orders" }));
    const rows: OrderPostingRow[] = [
      {
        shopId: "shop-a",
        shopName: "主店",
        postingNumber: "order-a-new",
        productsCount: 1,
        offerIds: ["SKU-A-NEW"],
        inProcessAt: "2026-07-27T03:00:00.000Z",
      },
      {
        shopId: "shop-b",
        shopName: "副店",
        postingNumber: "order-b",
        productsCount: 1,
        offerIds: ["SKU-B"],
        inProcessAt: "2026-07-27T02:00:00.000Z",
      },
      {
        shopId: "shop-a",
        shopName: "主店",
        postingNumber: "order-a-old",
        productsCount: 1,
        offerIds: ["SKU-A-OLD"],
        inProcessAt: "2026-07-27T01:00:00.000Z",
      },
    ];
    vi.mocked(api.listSavedOrderPostings).mockResolvedValue(rows);
    const onNavigate = vi.fn();

    render(
      <OrdersPage
        shops={[shop("shop-a", "主店"), shop("shop-b", "副店")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={onNavigate}
      />,
    );

    expect(await screen.findByText("order-a-new")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: /下载勾选 \(3\)/ }));
    const dialog = await screen.findByRole("dialog", { name: "填写物流贴单地址" });
    const textarea = dialog.querySelector("textarea")!;
    const duplicateUrl = "https://labels.example.test/duplicate.pdf";
    fireEvent.change(textarea, { target: { value: [duplicateUrl, duplicateUrl, duplicateUrl].join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "确认并下载" }));

    expect(await screen.findByText("同一个物流贴单地址不能重复使用")).toBeTruthy();
    expect(api.reserveOrderShippingLabels).not.toHaveBeenCalled();

    const urls = [
      "https://labels.example.test/label-3.pdf",
      "https://labels.example.test/label-1.pdf",
      "https://labels.example.test/label-2.pdf",
    ];
    fireEvent.change(textarea, { target: { value: urls.join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "确认并下载" }));

    await waitFor(() => expect(api.reserveOrderShippingLabels).toHaveBeenCalledWith([
      { shopId: "shop-a", orderNumber: "order-a-new", url: urls[0] },
      { shopId: "shop-b", orderNumber: "order-b", url: urls[1] },
      { shopId: "shop-a", orderNumber: "order-a-old", url: urls[2] },
    ]));
    await waitFor(() => expect(api.startOrderDocuments).toHaveBeenCalledTimes(2));
    expect(api.startOrderDocuments).toHaveBeenNthCalledWith(1, expect.objectContaining({
      shopId: "shop-a",
      orderNumbers: ["order-a-new", "order-a-old"],
      shippingLabels: [
        { orderNumber: "order-a-new", url: urls[0] },
        { orderNumber: "order-a-old", url: urls[2] },
      ],
    }));
    expect(api.startOrderDocuments).toHaveBeenNthCalledWith(2, expect.objectContaining({
      shopId: "shop-b",
      orderNumbers: ["order-b"],
      shippingLabels: [
        { orderNumber: "order-b", url: urls[1] },
      ],
    }));
    expect(onNavigate).toHaveBeenCalledWith("jobs");
  });

});


