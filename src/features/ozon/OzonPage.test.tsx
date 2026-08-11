import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, JobSummary, OrderPostingRow, Shop } from "@shared/types";
import { api } from "../../lib/api";
import { OzonPage } from "./OzonPage";

vi.mock("../../lib/api", () => ({
  api: {
    listTemplates: vi.fn().mockResolvedValue([]),
    listWarehouses: vi.fn().mockResolvedValue([]),
    listCategories: vi.fn().mockResolvedValue([]),
    listOrderPostings: vi.fn().mockResolvedValue([]),
    startListingMaintenance: vi.fn(),
    cancelJob: vi.fn(),
  },
}));

const listedUpdateDraftKey = "ozon-sjsq:listed-update-draft:v1";

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
    shopName: "Main shop",
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

describe("OzonPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.listTemplates).mockClear();
    vi.mocked(api.listWarehouses).mockReset().mockResolvedValue([]);
    vi.mocked(api.listCategories).mockReset().mockResolvedValue([]);
    vi.mocked(api.listOrderPostings).mockReset().mockResolvedValue([]);
    vi.mocked(api.startListingMaintenance).mockReset().mockImplementation(async (request) => ({
      id: `job-${request.shopId}`,
      kind: "listing_maintenance",
      title: "店铺自动运维",
      status: "running",
      progress: 5,
      inputPath: request.shopId,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    }));
    vi.mocked(api.cancelJob).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("restores category, video-shop and analytics drafts and drops invalid video shops", async () => {
    window.localStorage.setItem(listedUpdateDraftKey, JSON.stringify({
      shopId: "shop-b",
      tab: "inventory",
      selectedCategoryId: 123,
      categoryVideoShopIds: ["shop-b", "missing-shop"],
      categoryKeyword: "头巾",
      categoryLimit: 250,
      newPrice: "999",
      newOldPrice: "1299",
      currencyCode: "RUB",
      maintenanceActionCategoryId: 456,
      maintenanceActionId: 789,
      maintenanceActionPrice: "888",
      maintenanceActionStock: 50,
      analyticsDateFrom: "2026-07-01",
      analyticsDateTo: "2026-07-08",
      analyticsLimit: 400,
      minimumCardViews: 6,
      inventoryMode: "actions",
    }));

    render(
      <OzonPage
        shops={[shop("shop-a", "主店"), shop("shop-b", "跟卖2")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listTemplates).toHaveBeenCalledWith("product_import"));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(listedUpdateDraftKey) || "{}");
      expect(saved.shopId).toBe("shop-b");
      expect(saved.tab).toBe("inventory");
      expect(saved.selectedCategoryId).toBe(123);
      expect(saved.categoryVideoShopIds).toEqual(["shop-b"]);
      expect(saved.categoryKeyword).toBe("头巾");
      expect(saved.categoryLimit).toBe(250);
      expect(saved.newPrice).toBe("999");
      expect(saved.newOldPrice).toBe("1299");
      expect(saved.currencyCode).toBe("RUB");
      expect(saved.maintenanceActionCategoryId).toBe(456);
      expect(saved.maintenanceActionId).toBe(789);
      expect(saved.maintenanceActionPrice).toBe("888");
      expect(saved.maintenanceActionStock).toBe(50);
      expect(saved.analyticsDateFrom).toBe("2026-07-01");
      expect(saved.analyticsDateTo).toBe("2026-07-08");
      expect(saved.analyticsLimit).toBe(400);
      expect(saved.minimumCardViews).toBe(6);
      expect(saved.inventoryMode).toBe("actions");
    });
  });

  it("ignores an older order response after a newer status query completes", async () => {
    const waitingRequest = deferred<OrderPostingRow[]>();
    const allRequest = deferred<OrderPostingRow[]>();
    window.localStorage.setItem(listedUpdateDraftKey, JSON.stringify({ shopId: "shop-a" }));
    window.localStorage.setItem("ozon-sjsq:order-documents-draft:v1", JSON.stringify({
      shopId: "shop-a",
      orderStatus: "awaiting_packaging",
    }));
    vi.mocked(api.listOrderPostings).mockImplementation((request) => (
      request.status === "awaiting_packaging" ? waitingRequest.promise : allRequest.promise
    ));

    render(
      <OzonPage
        shops={[shop("shop-a", "Main shop")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "功能中心" }));
    fireEvent.click(await screen.findByRole("button", { name: /下载订单文件/ }));
    const panel = (await screen.findByRole("heading", { name: "获取店铺订单" })).closest("section")!;
    const statusSelect = within(panel).getByRole("combobox");
    const loadButton = within(panel).getByRole("button", { name: "获取订单" });
    fireEvent.click(loadButton);
    await waitFor(() => expect(api.listOrderPostings).toHaveBeenCalledWith(expect.objectContaining({ status: "awaiting_packaging" })));

    fireEvent.change(statusSelect, { target: { value: "" } });
    fireEvent.click(loadButton);
    await waitFor(() => expect(api.listOrderPostings).toHaveBeenCalledTimes(2));

    await act(async () => {
      allRequest.resolve([order("latest-order", "delivered")]);
      await allRequest.promise;
    });
    expect(screen.getByText("latest-order")).toBeTruthy();

    await act(async () => {
      waitingRequest.resolve([order("stale-order", "awaiting_packaging")]);
      await waitingRequest.promise;
    });
    expect(screen.queryByText("stale-order")).toBeNull();
    expect(screen.getByText("latest-order")).toBeTruthy();
  });

  it("auto-loads and caches warehouses and categories when a shop has no cache", async () => {
    vi.mocked(api.listWarehouses).mockResolvedValue([{ warehouseId: 101, name: "Main" }]);
    vi.mocked(api.listCategories).mockResolvedValue([{
      id: 201,
      name: "Headwear",
      level: 1,
      nodeKind: "category",
      descriptionCategoryId: 301,
    }]);

    render(
      <OzonPage
        shops={[shop("shop-a", "Main shop")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listWarehouses).toHaveBeenCalledWith("shop-a"));
    await waitFor(() => expect(api.listCategories).toHaveBeenCalledWith("shop-a"));
    await waitFor(() => {
      const warehouses = JSON.parse(window.localStorage.getItem("ozon-sjsq:query-cache:v1:shop-a:warehouses") || "{}");
      const categories = JSON.parse(window.localStorage.getItem("ozon-sjsq:query-cache:v1:shop-a:categories") || "{}");
      expect(warehouses.data).toEqual([{ warehouseId: 101, name: "Main" }]);
      expect(categories.data[0].descriptionCategoryId).toBe(301);
    });
  });

  it("restores warehouse and category caches without calling Ozon again", async () => {
    window.localStorage.setItem("ozon-sjsq:query-cache:v1:shop-a:warehouses", JSON.stringify({
      savedAt: "2026-07-12T00:00:00.000Z",
      data: [{ warehouseId: 101, name: "Cached warehouse" }],
    }));
    window.localStorage.setItem("ozon-sjsq:query-cache:v1:shop-a:categories", JSON.stringify({
      savedAt: "2026-07-12T00:00:00.000Z",
      data: [{ id: 201, name: "Cached category", level: 1, nodeKind: "category", descriptionCategoryId: 301 }],
    }));

    render(
      <OzonPage
        shops={[shop("shop-a", "Main shop")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listTemplates).toHaveBeenCalledWith("product_import"));
    expect(api.listWarehouses).not.toHaveBeenCalled();
    expect(api.listCategories).not.toHaveBeenCalled();
  });

  it("starts listing maintenance for all enabled shops from the management page", async () => {
    const onChanged = vi.fn();

    render(
      <OzonPage
        shops={[
          shop("shop-a", "Main shop"),
          shop("shop-b", "Second shop"),
          shop("shop-c", "Disabled shop", false),
        ]}
        settings={settings}
        onChanged={onChanged}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全部店铺执行" }));

    await waitFor(() => expect(api.startListingMaintenance).toHaveBeenCalledTimes(2));
    expect(api.startListingMaintenance).toHaveBeenNthCalledWith(1, expect.objectContaining({ shopId: "shop-a" }));
    expect(api.startListingMaintenance).toHaveBeenNthCalledWith(2, expect.objectContaining({ shopId: "shop-b" }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("stops only running listing maintenance jobs from the management page", async () => {
    const jobs: JobSummary[] = [
      {
        id: "maintenance-a",
        kind: "listing_maintenance",
        title: "店铺自动运维",
        status: "running",
        progress: 10,
        inputPath: "shop-a",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
      {
        id: "upload-a",
        kind: "auto_listing",
        title: "自动上架",
        status: "running",
        progress: 10,
        inputPath: "batch-a",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
    ];

    render(
      <OzonPage
        shops={[shop("shop-a", "Main shop")]}
        jobs={jobs}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全部店铺停止" }));

    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith("maintenance-a"));
    expect(api.cancelJob).toHaveBeenCalledTimes(1);
  });
  it("renders the compact feature menu without descriptions", async () => {
    render(
      <OzonPage
        shops={[shop("shop-a", "Main shop")]}
        settings={settings}
        onChanged={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "功能中心" }));
    const navigation = await screen.findByRole("navigation", { name: "Ozon 任务导航" });

    expect(navigation.className).toContain("shop-function-menu");
    expect(within(navigation).queryByText("用 Excel、图片目录和商品模板创建 Ozon 上架任务。")).toBeNull();
    fireEvent.click(within(navigation).getByRole("button", { name: "更新商品" }));
    expect(await screen.findByRole("heading", { name: "已上架更新" })).toBeTruthy();
  });
});
